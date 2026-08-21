import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildZipBuffer } from "@/lib/artifacts/build";
import { parseArtifactBlockByName } from "@/lib/artifacts/parse";
import { validateArtifact } from "@/lib/artifacts/validate";
import { contentDisposition, validateArtifactFilename } from "@/lib/artifacts/paths";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { enforceBodyLimit } from "@/lib/http/body-limit";

/**
 * Legacy ZIP export.
 *
 * Kept for conversations created before artifacts moved into their own table; new
 * artifacts are served by /api/artifacts/[id]/download. Both paths share the same
 * validation and packaging code, so path-traversal and secret rules are identical.
 */

const bodySchema = z.object({
  messageId: z.string().min(1).max(64),
  filename: z.string().min(1).max(120),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const limited = enforceRateLimit("export", req, userId);
    if (limited) return limited;

    let raw: unknown;
    try {
      const oversized = enforceBodyLimit(req, "json");
      if (oversized) return oversized;
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsedBody = bodySchema.safeParse(raw);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Missing messageId or filename" }, { status: 400 });
    }

    const nameCheck = validateArtifactFilename(parsedBody.data.filename, [".zip"]);
    if (!nameCheck.ok) {
      return NextResponse.json({ error: `Invalid filename: ${nameCheck.reason}` }, { status: 400 });
    }
    const filename = nameCheck.value;

    const message = await prisma.message.findFirst({
      where: { id: parsedBody.data.messageId, conversation: { userId } },
      select: { content: true },
    });

    if (!message) {
      return NextResponse.json({ error: "Not Found or Unauthorized" }, { status: 404 });
    }

    const rawArtifact = parseArtifactBlockByName(message.content, "zip", filename);
    if (!rawArtifact) {
      return NextResponse.json({ error: "Artifact not found in message" }, { status: 404 });
    }

    // Unsafe paths and incomplete files are rejected outright — never skipped and
    // never rewritten into a different path.
    const validation = validateArtifact(rawArtifact, "zip");
    if (!validation.ok) {
      return NextResponse.json(
        { error: `Refusing to build this archive: ${validation.errors[0]}` },
        { status: 400 }
      );
    }

    const buffer = await buildZipBuffer(validation.artifact);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(filename),
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error("ZIP export failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to generate ZIP" }, { status: 500 });
  }
}
