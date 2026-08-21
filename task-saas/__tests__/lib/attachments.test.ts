import { describe, it, expect } from "vitest";
import {
  validateImageDataUrl,
  normalizeDocumentAttachment,
  splitAttachmentBlock,
  stripAttachmentTag,
  MAX_DOCUMENT_CHARS,
} from "@/lib/attachments";

/** Smallest valid PNG (1x1, transparent). */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

/** Minimal JPEG magic bytes padded to a valid base64 length. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;

describe("validateImageDataUrl", () => {
  it("accepts a CodeMind-produced PNG data URL", () => {
    const result = validateImageDataUrl(PNG_DATA_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mediaType).toBe("image/png");
      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.byteSize).toBeGreaterThan(0);
    }
  });

  it("accepts a JPEG data URL", () => {
    expect(validateImageDataUrl(JPEG_DATA_URL)).toMatchObject({ ok: true, mediaType: "image/jpeg" });
  });

  describe("rejects remote and non-data schemes", () => {
    const urls = [
      "https://example.com/pic.png",
      "http://example.com/pic.png",
      "http://localhost:3000/internal.png",
      "http://127.0.0.1/internal.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/secret.png",
      "http://192.168.1.1/router.png",
      "file:///etc/passwd",
      "ftp://example.com/pic.png",
      "blob:https://example.com/abc",
      "//example.com/pic.png",
    ];

    for (const url of urls) {
      it(`rejects ${url}`, () => {
        const result = validateImageDataUrl(url);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/remote URLs are not allowed|data URL/);
      });
    }
  });

  it("rejects disallowed image formats", () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).toString("base64");
    expect(validateImageDataUrl(`data:image/gif;base64,${gif}`)).toMatchObject({ ok: false });
    expect(validateImageDataUrl(`data:image/svg+xml;base64,${gif}`)).toMatchObject({ ok: false });
    expect(validateImageDataUrl(`data:text/html;base64,${gif}`)).toMatchObject({ ok: false });
    expect(validateImageDataUrl(`data:application/pdf;base64,${gif}`)).toMatchObject({ ok: false });
  });

  it("rejects a declared type that disagrees with the actual bytes", () => {
    // Real PNG bytes, but claimed to be a JPEG.
    const result = validateImageDataUrl(`data:image/jpeg;base64,${PNG_BASE64}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match its declared type/);
  });

  it("rejects payloads that are not really images", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    expect(validateImageDataUrl(`data:image/png;base64,${html}`)).toMatchObject({ ok: false });
  });

  it("rejects malformed base64", () => {
    expect(validateImageDataUrl("data:image/png;base64,!!!!not-base64!!!!")).toMatchObject({
      ok: false,
    });
    expect(validateImageDataUrl("data:image/png;base64,")).toMatchObject({ ok: false });
    expect(validateImageDataUrl("data:image/png;base64,abc")).toMatchObject({ ok: false });
  });

  it("rejects oversized images without allocating them", () => {
    // 11MB of base64 characters, over the 10MB decoded cap.
    const oversized = "A".repeat(16 * 1024 * 1024);
    const result = validateImageDataUrl(`data:image/png;base64,${oversized}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/limit/);
  });

  it("rejects non-strings and empties", () => {
    expect(validateImageDataUrl(null)).toMatchObject({ ok: false });
    expect(validateImageDataUrl(undefined)).toMatchObject({ ok: false });
    expect(validateImageDataUrl(123)).toMatchObject({ ok: false });
    expect(validateImageDataUrl("")).toMatchObject({ ok: false });
  });
});

describe("normalizeDocumentAttachment", () => {
  it("clamps document length", () => {
    const long = "x".repeat(MAX_DOCUMENT_CHARS + 5_000);
    const result = normalizeDocumentAttachment("notes.txt", long);
    expect(result?.extractedText.length).toBe(MAX_DOCUMENT_CHARS);
  });

  it("falls back to a safe name and strips newlines", () => {
    expect(normalizeDocumentAttachment(undefined, "text")?.name).toBe("attachment");
    expect(normalizeDocumentAttachment("a\nb.txt", "text")?.name).toBe("a b.txt");
  });

  it("drops documents with no text", () => {
    expect(normalizeDocumentAttachment("a.txt", "")).toBeNull();
    expect(normalizeDocumentAttachment("a.txt", "   ")).toBeNull();
    expect(normalizeDocumentAttachment("a.txt", null)).toBeNull();
  });
});

describe("attachment tag helpers", () => {
  it("splits the attachment block from the visible text", () => {
    const raw = 'Look at this\n\n<codemind_attachments>{"attachments":[]}</codemind_attachments>';
    const { text, raw: block } = splitAttachmentBlock(raw);
    expect(text).toBe("Look at this");
    expect(block).toBe('{"attachments":[]}');
  });

  it("returns raw: null when there is no block", () => {
    expect(splitAttachmentBlock("just text")).toEqual({ text: "just text", raw: null });
  });

  it("strips the tag", () => {
    expect(stripAttachmentTag("hi <codemind_attachments>x</codemind_attachments>")).toBe("hi");
  });
});
