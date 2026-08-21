/**
 * Attachment validation for chat requests.
 *
 * Threat model: `messages[]` arrives from the browser and is fully attacker-controlled
 * for any authenticated user. Attachment metadata is re-validated here rather than
 * trusted, and image payloads are only accepted as self-contained base64 data URLs
 * produced by /api/upload.
 *
 * Remote image URLs are rejected outright. The AI SDK forwards a URL-valued image part
 * to the model provider to fetch, which would turn an authenticated chat request into
 * a server-side fetch of an arbitrary attacker-chosen URL. Decoded bytes are passed
 * instead, so no fetch can occur.
 */

/**
 * Wire tag the composer uses to carry attachment metadata inside message text.
 * Shared by the chat route, the context manager and the chat UI so the three
 * cannot drift apart.
 */
export const ATTACHMENT_TAG_RE = /<codemind_attachments>([\s\S]*?)<\/codemind_attachments>/;

/** Remove the attachment block from a message, leaving the user's own text. */
export function stripAttachmentTag(content: string): string {
  return content.replace(ATTACHMENT_TAG_RE, "").trim();
}

/**
 * Split a raw message into its visible text and its raw attachment block.
 * Returns `raw: null` when the message carries no attachments.
 */
export function splitAttachmentBlock(content: string): { text: string; raw: string | null } {
  const match = ATTACHMENT_TAG_RE.exec(content);
  if (!match) return { text: content.trim(), raw: null };
  return { text: stripAttachmentTag(content), raw: match[1] };
}

export const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** Matches the 10MB cap enforced by /api/upload. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Matches the 50k character truncation applied by /api/upload. */
export const MAX_DOCUMENT_CHARS = 50_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

export type ImageCheck =
  | { ok: true; mediaType: AllowedImageMimeType; data: Uint8Array; byteSize: number }
  | { ok: false; reason: string };

const fail = (reason: string): ImageCheck => ({ ok: false, reason });

const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/\s]+={0,2})$/;

/** Identify an image by magic bytes, independent of its declared MIME type. */
function sniffImageMimeType(bytes: Uint8Array): AllowedImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * Validate an image attachment URL.
 *
 * Accepts only `data:` URLs carrying base64 PNG/JPEG/WEBP whose magic bytes agree with
 * the declared MIME type. Every other scheme — http(s), file, ftp, blob, and any
 * localhost / private-network address — is rejected.
 */
export function validateImageDataUrl(raw: unknown): ImageCheck {
  if (typeof raw !== "string") return fail("image url must be a string");

  const value = raw.trim();
  if (value.length === 0) return fail("image url is empty");

  if (!value.startsWith("data:")) {
    return fail("only images uploaded through CodeMind are accepted; remote URLs are not allowed");
  }

  const match = DATA_URL_PATTERN.exec(value);
  if (!match) {
    return fail(
      `image must be a base64 data URL with one of: ${ALLOWED_IMAGE_MIME_TYPES.join(", ")}`
    );
  }

  const declaredMime = match[1] as AllowedImageMimeType;
  const base64 = match[2].replace(/\s+/g, "");

  if (base64.length === 0) return fail("image payload is empty");
  if (base64.length % 4 !== 0) return fail("image payload is not valid base64");

  // Reject before allocating: 4 base64 chars encode 3 bytes.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return fail(`image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit`);
  }

  const buffer = Buffer.from(base64, "base64");
  // Buffer.from is lenient; round-tripping proves the input was strict base64.
  if (buffer.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    return fail("image payload is not valid base64");
  }
  if (buffer.length === 0) return fail("image payload is empty");
  if (buffer.length > MAX_IMAGE_BYTES) {
    return fail(`image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit`);
  }

  const sniffed = sniffImageMimeType(buffer);
  if (!sniffed) return fail("image content is not a recognised PNG, JPEG or WEBP");
  if (sniffed !== declaredMime) {
    return fail(`image content (${sniffed}) does not match its declared type (${declaredMime})`);
  }

  return {
    ok: true,
    mediaType: declaredMime,
    data: new Uint8Array(buffer),
    byteSize: buffer.length,
  };
}

export interface ValidatedDocument {
  name: string;
  extractedText: string;
}

/** Clamp a document attachment to a safe name and length. */
export function normalizeDocumentAttachment(
  name: unknown,
  extractedText: unknown
): ValidatedDocument | null {
  if (typeof extractedText !== "string" || extractedText.trim().length === 0) return null;

  const safeName =
    typeof name === "string" && name.trim().length > 0
      ? name.trim().slice(0, 200).replace(/[\r\n]+/g, " ")
      : "attachment";

  return {
    name: safeName,
    extractedText: extractedText.slice(0, MAX_DOCUMENT_CHARS),
  };
}
