/**
 * Request body size limits.
 *
 * The problem this solves: `await request.json()` and `await request.formData()` have
 * already materialised the entire body in memory by the time any validation runs. A
 * Zod schema that caps a single message at 2,000,000 characters does not cap the
 * request — 200 messages of that size is a 400MB allocation that Zod only rejects
 * after the heap has taken it. App Router route handlers apply no default cap of their
 * own, so this is the only place it can be enforced.
 *
 * These are HTTP transport limits and are deliberately NOT the AI context limit. The
 * 512,000-token context window is about what the model is asked to read; this is about
 * how many bytes the process will hold at once. They are sized so that every request
 * CodeMind actually makes fits comfortably.
 */

import { logger } from "@/lib/logger";

export const BODY_LIMITS = {
  /**
   * POST /api/chat.
   *
   * A full 512K-token turn is roughly 2MB of UTF-8 text, and the client re-sends the
   * conversation each turn, so the text side needs a few MB at most. The rest is
   * headroom for image attachments, which travel inside the message as base64 data
   * URLs and inflate 4:3.
   *
   * Kept above MAX_TOTAL_REQUEST_CHARS in types/chat.ts so the transport limit never
   * rejects a payload the schema would have accepted. The two must move together.
   */
  chat: 48 * 1024 * 1024,

  /** POST /api/upload — one file up to 10MB, plus multipart framing. */
  upload: 12 * 1024 * 1024,

  /** Ordinary JSON APIs: projects, conversations, exports, registration. */
  json: 256 * 1024,

  /**
   * PATCH /api/projects/:id carries instructions (20,000 chars) and memory
   * (20 sections × 50 items × 500 chars ≈ 500,000 chars).
   */
  projectSettings: 2 * 1024 * 1024,
} as const;

export type BodyLimitName = keyof typeof BODY_LIMITS;

/**
 * Reject an oversized request before its body is read.
 *
 * Returns a 413 Response when the declared length exceeds the limit, or null when the
 * caller may proceed to parse.
 *
 * A request with no `Content-Length` (chunked transfer) cannot be pre-checked and is
 * allowed through to schema validation. Every client CodeMind ships — `fetch` from the
 * browser, the AI SDK — sends a length for these bodies, so this is a gap in what an
 * attacker gains rather than a gap in normal operation.
 */
export function enforceBodyLimit(request: Request, name: BodyLimitName): Response | null {
  const limit = BODY_LIMITS[name];
  const header = request.headers.get("content-length");
  if (!header) return null;

  const declared = Number.parseInt(header, 10);
  if (Number.isNaN(declared) || declared < 0) return null;
  if (declared <= limit) return null;

  logger.warn("Request body rejected as oversized", {
    limitName: name,
    limitBytes: limit,
    declaredBytes: declared,
  });

  return Response.json(
    {
      error: `Request body is too large. The limit for this endpoint is ${Math.floor(
        limit / (1024 * 1024)
      )}MB.`,
    },
    { status: 413 }
  );
}
