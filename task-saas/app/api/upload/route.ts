import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_DOCUMENT_CHARS,
  MAX_IMAGE_BYTES,
} from "@/lib/attachments";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { enforceBodyLimit } from "@/lib/http/body-limit";

// pdf-parse v2 dropped the old callable-function export in favor of a PDFParse class.
const { PDFParse } = require("pdf-parse");

/** Upper bound for any upload, including documents. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const TEXT_FILE_EXTENSIONS =
  /\.(md|json|ts|tsx|js|jsx|py|java|c|cpp|h|css|html|yml|yaml|sh)$/i;

/**
 * How long a single PDF may take to parse, and how many pages are read.
 *
 * pdf-parse runs synchronously inside the request. A deliberately pathological file —
 * deeply nested objects, a decompression bomb, tens of thousands of pages — can hold a
 * worker indefinitely, and the upload bucket allows 30 of those a minute.
 */
const PDF_PARSE_TIMEOUT_MS = 15_000;
const PDF_MAX_PAGES = 500;

/**
 * Parse a PDF, giving up after PDF_PARSE_TIMEOUT_MS.
 *
 * The timeout bounds how long the REQUEST waits, not the parser itself: pdf-parse
 * offers no cancellation, so a runaway parse continues in the background until it
 * finishes. That is still the difference between one slow request and a worker pinned
 * forever, and the page cap keeps the common pathological cases from starting at all.
 */
async function parsePdfWithTimeout(buffer: Buffer): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const parser = new PDFParse({ data: buffer });

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PDF_PARSE_TIMEOUT_MS);
  });

  try {
    const parsed = await Promise.race([
      parser.getText({ first: PDF_MAX_PAGES }),
      timeout,
    ]);
    if (parsed === null) return null;
    return typeof parsed.text === "string" ? parsed.text : "";
  } finally {
    if (timer) clearTimeout(timer);
    await parser.destroy();
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limited = enforceRateLimit("upload", req, session.user.id);
    if (limited) return limited;

    const oversized = enforceBodyLimit(req, "upload");
    if (oversized) return oversized;
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
      const text = await parsePdfWithTimeout(buffer);
      if (text === null) {
        logger.warn("PDF parsing timed out", { byteSize: buffer.length });
        return NextResponse.json(
          {
            error:
              "This PDF took too long to read. Try a smaller file, or paste the text you need directly.",
          },
          { status: 422 }
        );
      }
      return NextResponse.json({
        type: "document",
        name,
        extractedText: text.substring(0, MAX_DOCUMENT_CHARS),
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
