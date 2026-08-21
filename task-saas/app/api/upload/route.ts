import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_DOCUMENT_CHARS,
  MAX_IMAGE_BYTES,
} from "@/lib/attachments";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// pdf-parse is CommonJS with no usable ESM default export in this setup.
const pdfParse = require("pdf-parse");

/** Upper bound for any upload, including documents. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const TEXT_FILE_EXTENSIONS =
  /\.(md|json|ts|tsx|js|jsx|py|java|c|cpp|h|css|html|yml|yaml|sh)$/i;

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limited = enforceRateLimit("upload", req, session.user.id);
    if (limited) return limited;

    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
    }

    const type = file.type;
    const name = file.name;
    const buffer = Buffer.from(await file.arrayBuffer());

    if (type === "application/pdf") {
      const data = await pdfParse(buffer);
      return NextResponse.json({
        type: "document",
        name,
        extractedText: String(data.text).substring(0, MAX_DOCUMENT_CHARS),
      });
    }

    const isText = type.startsWith("text/") || TEXT_FILE_EXTENSIONS.test(name);
    if (isText) {
      return NextResponse.json({
        type: "document",
        name,
        extractedText: buffer.toString("utf-8").substring(0, MAX_DOCUMENT_CHARS),
      });
    }

    if (type.startsWith("image/")) {
      if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(type)) {
        return NextResponse.json({ error: "Unsupported image format" }, { status: 400 });
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "Image exceeds 10MB limit" }, { status: 400 });
      }

      // Returned as a self-contained data URL. /api/chat accepts image attachments
      // in this form only, so no remote URL can enter the vision pipeline.
      return NextResponse.json({
        type: "image",
        name,
        url: `data:${type};base64,${buffer.toString("base64")}`,
      });
    }

    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  } catch (error) {
    logger.error("Upload failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "File processing failed" }, { status: 500 });
  }
}
