import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildPdfBuffer } from "@/lib/artifacts/build";
import { contentDisposition, validateArtifactFilename } from "@/lib/artifacts/paths";
import { stripAttachmentTag } from "@/lib/attachments";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { enforceBodyLimit } from "@/lib/http/body-limit";

/**
 * Export any assistant message as a PDF.
 *
 * Distinct from a generated `pdf` artifact: this renders an existing chat reply on
 * demand, so it stays useful for ordinary answers that were never artifacts.
 */

const bodySchema = z.object({
  messageId: z.string().min(1).max(64),
  filename: z.string().min(1).max(120).optional(),
});

/** Strip any legacy artifact markup so it never reaches the rendered page. */
const ARTIFACT_MARKUP_RE =
  /<codemind_artifact\s+type="[^"]*"\s+name="[^"]*"(?:\s*\/>|>[\s\S]*?<\/codemind_artifact>)/gi;

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
      return NextResponse.json({ error: "No messageId provided" }, { status: 400 });
    }

    const message = await prisma.message.findFirst({
      where: { id: parsedBody.data.messageId, conversation: { userId } },
      select: { id: true, content: true },
    });

    if (!message) {
      return NextResponse.json({ error: "Not Found or Unauthorized" }, { status: 404 });
    }

    const requested = parsedBody.data.filename ?? `codemind-report-${message.id}.pdf`;
    const nameCheck = validateArtifactFilename(requested, [".pdf"]);
    const filename = nameCheck.ok ? nameCheck.value : `codemind-report-${message.id}.pdf`;

    const cleanContent = stripAttachmentTag(message.content)
      .replace(ARTIFACT_MARKUP_RE, "")
      .trim();

    if (cleanContent.length === 0) {
      return NextResponse.json({ error: "This message has no text to export" }, { status: 400 });
    }

    const buffer = await buildPdfBuffer(cleanContent);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition(filename),
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error("PDF export failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
  }
}
