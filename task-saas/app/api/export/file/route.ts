import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { parseArtifactBlockByName } from "@/lib/artifacts/parse";
import { validateArtifact } from "@/lib/artifacts/validate";
import { contentDisposition, validateArtifactFilename } from "@/lib/artifacts/paths";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Legacy single-file export. See app/api/export/zip/route.ts for why this remains.
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
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsedBody = bodySchema.safeParse(raw);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Missing messageId or filename" }, { status: 400 });
    }

    const nameCheck = validateArtifactFilename(parsedBody.data.filename);
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

    const rawArtifact = parseArtifactBlockByName(message.content, "file", filename);
    if (!rawArtifact) {
      return NextResponse.json({ error: "Artifact not found in message" }, { status: 404 });
    }

    const validation = validateArtifact(rawArtifact, "file");
    if (!validation.ok) {
      return NextResponse.json(
        { error: `Cannot export this file: ${validation.errors[0]}` },
        { status: 400 }
      );
    }

    const content = validation.artifact.files[0].content;

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": contentDisposition(filename),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error("File export failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to export file" }, { status: 500 });
  }
}
