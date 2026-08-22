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
 * how many bytes the process will hold at once.
 *
 * The chat limit is environment-configurable because it is the one that scales with
 * the host rather than with the product — see `bodyLimitBytes` below. Its default is
 * sized for a 512MB instance; a larger machine raises it without a code change.
 */

import { logger } from "@/lib/logger";
import { getChatBodyLimitBytes } from "@/lib/env";

/**
 * Fixed limits. These bound small, well-understood payloads whose size is a property
 * of the schema rather than of the machine, so there is nothing to tune per instance.
 */
const FIXED_LIMITS = {
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

export type BodyLimitName = "chat" | keyof typeof FIXED_LIMITS;

/**
 * The byte ceiling for one endpoint.
 *
 * `chat` is the only limit that scales with the host, because it is the only one large
 * enough to matter against a small instance's memory: a full 512K-token turn plus a
 * base64 image attachment. It comes from CODEMIND_CHAT_BODY_MAX_BYTES, defaulting to a
 * value sized for a 512MB instance and raised through the environment on a larger one.
 * See README "Request size limits".
 *
 * Read per call rather than captured at module load, so the value tracks the
 * environment without needing a rebuild.
 */
export function bodyLimitBytes(name: BodyLimitName): number {
  return name === "chat" ? getChatBodyLimitBytes() : FIXED_LIMITS[name];
}

/**
 * Fixed limits only, exported for tests and callers that need a compile-time value.
 * Use `bodyLimitBytes()` for anything that must respect the environment.
 */
export const BODY_LIMITS = FIXED_LIMITS;

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
  const limit = bodyLimitBytes(name);
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
