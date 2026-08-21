/**
 * Failure classification for the AI provider gateway.
 *
 * The gateway rotates a pool of NVIDIA API keys behind a single `fetch`. Its original
 * policy treated "429 or 5xx" as one bucket with a flat 60s cooldown, ignored 401
 * entirely, and had no way to tell a *request* problem from a *key* problem. That is
 * wrong in three expensive ways:
 *
 * 1. A bad credential (401/403) would be retried against the same key forever, because
 *    nothing ever marked it unhealthy.
 * 2. A context-length rejection (400) looks like a normal failure, so the gateway would
 *    burn every key in the pool on a request that is guaranteed to fail on all of them.
 * 3. A malformed request (422, 404) would be retried even though retrying cannot help.
 *
 * This module is the pure decision layer: given an HTTP status (or a thrown error), it
 * answers three questions the gateway needs — do we try another key, how long do we cool
 * this key down, and is this key permanently bad? It performs no I/O and holds no state,
 * so it is trivially testable and safe to import from anywhere.
 *
 * SECURITY: every string this module emits is scrubbed. `reason` is written into
 * structured logs, and response bodies from the provider can echo request content back.
 * Nothing here may leak an API key, an Authorization header, a user prompt, or uploaded
 * document text. See `scrubForLog`.
 */

import { redactSecrets } from "@/lib/logger";

export type FailureKind =
  | "rate_limit"
  | "server_error"
  | "network"
  | "auth"
  | "context_length"
  | "client_error"
  | "aborted"
  | "unknown";

export interface FailureClassification {
  kind: FailureKind;
  /** Should the gateway try a DIFFERENT key for this same request? */
  shouldFailover: boolean;
  /** Cooldown to apply to the key that produced this failure. 0 = none. */
  cooldownMs: number;
  /** Mark the key unhealthy/disabled (invalid credential). */
  markUnhealthy: boolean;
  /** Safe, non-secret reason for structured logs. */
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cooldown applied to a key that returned 429. Long enough for a per-minute quota
 * window to roll over, short enough that a transient burst does not sideline the key.
 */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Cooldown for provider-side 5xx and for network faults — both are usually seconds-scale. */
export const TRANSIENT_COOLDOWN_MS = 30_000;

/**
 * Cooldown for an invalid credential. A revoked or mistyped key does not heal in a
 * minute, so we park it for a long stretch rather than re-probing it on every request.
 * Combined with `markUnhealthy`, this guarantees a bad key is never hot-looped.
 */
export const AUTH_COOLDOWN_MS = 15 * 60_000;

/** No cooldown: the key is fine, the request was the problem. */
export const NO_COOLDOWN_MS = 0;

/** Hard cap on any provider text echoed into `reason`. */
export const MAX_REASON_BODY_CHARS = 200;

/** Sanity bounds for a Retry-After value parsed out of a body snippet. */
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 300;
const MS_PER_SECOND = 1_000;

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MAX = 499;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

/* -------------------------------------------------------------------------- */
/* Secret scrubbing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Make an arbitrary provider string safe to log or display.
 *
 * The credential patterns live in lib/logger.ts so there is exactly one definition of
 * "what a secret looks like"; this adds the collapsing and truncation that a provider
 * body needs but a general log line does not.
 *
 * Order matters: redact FIRST, then truncate. Truncating first could slice a key in
 * half and leave the leading fragment unmatched, defeating the redaction. Whitespace is
 * collapsed so a multi-line HTML error page cannot spray the log.
 */
export function scrubForLog(input: string, maxChars: number = MAX_REASON_BODY_CHARS): string {
  const safe = redactSecrets(input).replace(/\s+/g, " ").trim();
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
}

/** `reason` builder: a stable prefix plus optional, always-scrubbed provider detail. */
function reasonWithDetail(summary: string, bodySnippet: string): string {
  const detail = scrubForLog(bodySnippet);
  return detail ? `${summary}: ${detail}` : summary;
}

/* -------------------------------------------------------------------------- */
/* Context-length detection                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Phrases providers use when the prompt itself is too long. OpenAI-compatible endpoints
 * (which NVIDIA NIM mirrors) return these as a 400 with an error code or message.
 */
const CONTEXT_LENGTH_MARKERS: readonly string[] = [
  "maximum context length",
  "context_length_exceeded",
  "context length exceeded",
  "reduce the length of the messages",
  "too many tokens",
  "exceeds the maximum",
  "input is too long",
];

/**
 * True when this is a provider context-length rejection.
 *
 * Only 4xx statuses are considered: a 500 that happens to contain the word "tokens" is a
 * server fault, not an oversized prompt, and must stay failover-eligible.
 */
export function isContextLengthError(status: number, bodySnippet: string): boolean {
  if (status < HTTP_BAD_REQUEST || status > HTTP_CLIENT_ERROR_MAX) return false;
  const haystack = bodySnippet.toLowerCase();
  return CONTEXT_LENGTH_MARKERS.some((marker) => haystack.includes(marker));
}

/* -------------------------------------------------------------------------- */
/* Retry-After parsing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Providers often restate the backoff in the 429 body ("retry after 20 seconds",
 * "retry-after: 20"). When it is trivially present we honour it instead of the flat
 * default — under-waiting wastes a retry, over-waiting sidelines a healthy key.
 *
 * Only bare second counts are parsed. An HTTP-date form is deliberately ignored: dates
 * require clock-skew handling that is not worth the risk here, and the default applies.
 */
const RETRY_AFTER_PATTERNS: readonly RegExp[] = [
  /retry[-_\s]?after["'\s:=]+(\d+(?:\.\d+)?)/i,
  /(?:retry|try\s+again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i,
];

function parseRetryAfterMs(bodySnippet: string): number | null {
  for (const pattern of RETRY_AFTER_PATTERNS) {
    const match = pattern.exec(bodySnippet);
    if (!match) continue;
    const seconds = Number.parseFloat(match[1]);
    if (!Number.isFinite(seconds)) continue;
    if (seconds < MIN_RETRY_AFTER_SECONDS || seconds > MAX_RETRY_AFTER_SECONDS) continue;
    return Math.round(seconds * MS_PER_SECOND);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

/** Classify a non-2xx HTTP response. bodySnippet may be empty. */
export function classifyResponse(status: number, bodySnippet: string): FailureClassification {
  const snippet = bodySnippet ?? "";

  // Checked before the generic 4xx branch: a context-length 400 is an APPLICATION problem,
  // not a credential problem. Every key in the pool would reject the same oversized prompt,
  // so failing over just burns the whole pool and still fails. The ContextManager recovery
  // in app/api/chat/route.ts trims the conversation and retries — that is the real fix.
  if (isContextLengthError(status, snippet)) {
    return {
      kind: "context_length",
      shouldFailover: false,
      cooldownMs: NO_COOLDOWN_MS,
      markUnhealthy: false,
      reason: reasonWithDetail(`Context length exceeded (HTTP ${status})`, snippet),
    };
  }

  // Quota exhausted on THIS key. Other keys have independent quotas, so failover is the
  // right move; cool this one down so the scheduler stops picking it.
  if (status === HTTP_TOO_MANY_REQUESTS) {
    const parsed = parseRetryAfterMs(snippet);
    return {
      kind: "rate_limit",
      shouldFailover: true,
      cooldownMs: parsed ?? RATE_LIMIT_COOLDOWN_MS,
      markUnhealthy: false,
      reason:
        parsed === null
          ? `Rate limited (HTTP 429); default cooldown ${RATE_LIMIT_COOLDOWN_MS}ms`
          : `Rate limited (HTTP 429); provider-suggested cooldown ${parsed}ms`,
    };
  }

  // Invalid/revoked credential. Failover IS correct — the pool's other keys may be fine —
  // but this key must be taken out of rotation, not merely paused: retrying a dead key
  // costs a round trip every time and never succeeds.
  //
  // Only 401 earns that verdict. 401 is unreachable from user input, because the
  // Authorization header is chosen entirely server-side.
  if (status === HTTP_UNAUTHORIZED) {
    return {
      kind: "auth",
      shouldFailover: true,
      cooldownMs: AUTH_COOLDOWN_MS,
      markUnhealthy: true,
      reason: "Invalid or rejected credential (HTTP 401); key marked unhealthy",
    };
  }

  // 403 is deliberately NOT treated as a dead credential. NIM endpoints and any
  // fronting WAF/CDN also return 403 for content-policy and request-shape reasons, so
  // a 403 can be reachable from user input. Disabling on it would let a crafted prompt
  // walk the whole pool out of rotation for 15 minutes. Fail over, cool briefly, and
  // leave the key healthy.
  if (status === HTTP_FORBIDDEN) {
    return {
      kind: "auth",
      shouldFailover: true,
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      markUnhealthy: false,
      reason: "Request rejected (HTTP 403); key cooled briefly but left in rotation",
    };
  }

  // Provider-side fault, unrelated to which key was used, and usually short lived.
  if (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX) {
    return {
      kind: "server_error",
      shouldFailover: true,
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      markUnhealthy: false,
      reason: `Provider server error (HTTP ${status})`,
    };
  }

  // Remaining 4xx: malformed body, unknown model, validation failure. Deterministic —
  // the identical request fails identically on every key, so retrying is pure waste.
  if (status >= HTTP_BAD_REQUEST && status <= HTTP_CLIENT_ERROR_MAX) {
    return {
      kind: "client_error",
      shouldFailover: false,
      cooldownMs: NO_COOLDOWN_MS,
      markUnhealthy: false,
      reason: reasonWithDetail(`Client request error (HTTP ${status})`, snippet),
    };
  }

  // Conservative default. We do not understand this status, so we do not spend keys on it.
  return {
    kind: "unknown",
    shouldFailover: false,
    cooldownMs: NO_COOLDOWN_MS,
    markUnhealthy: false,
    reason: `Unclassified response (HTTP ${status})`,
  };
}

/** Error shapes Node/undici use for transport faults; narrowed without `any`. */
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

function asErrorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Best-effort, non-secret label for a thrown transport error.
 *
 * Only the error's `name` and `code` are used. The `message` is deliberately NOT logged:
 * undici embeds the request URL — and therefore anything the caller put in it — in some
 * messages, and we cannot guarantee it is free of user content.
 */
function describeNetworkError(error: unknown): string {
  const err = asErrorLike(error);
  if (!err) return "unknown transport fault";

  const parts: string[] = [];
  const name = readString(err.name);
  const code = readString(err.code) || readString(asErrorLike(err.cause)?.code);
  if (name) parts.push(name);
  if (code) parts.push(code);

  return parts.length > 0 ? scrubForLog(parts.join(" / ")) : "unknown transport fault";
}

/**
 * True when the caller cancelled the request — a browser disconnect, a user pressing
 * stop, or an upstream timeout guard firing.
 */
export function isAbortError(error: unknown): boolean {
  const err = asErrorLike(error);
  if (!err) return false;
  const name = readString(err.name);
  const code = readString(err.code) || readString(asErrorLike(err.cause)?.code);
  return name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR";
}

/**
 * Classify a thrown error from fetch (network failure, abort, timeout).
 *
 * Aborts are separated out deliberately. When the user navigates away or presses stop,
 * the provider and the key are both blameless — cooling the key down would sideline a
 * healthy credential, and failing over would spend a second key re-running work nobody
 * is waiting for. The lease is simply released and the request ends.
 *
 * Everything else is treated like a 5xx: the request never got a verdict, the key is not
 * implicated, and the fault is usually transient — failover with a short cooldown, and
 * never mark the key unhealthy.
 */
export function classifyNetworkError(error: unknown): FailureClassification {
  if (isAbortError(error)) {
    return {
      kind: "aborted",
      shouldFailover: false,
      cooldownMs: NO_COOLDOWN_MS,
      markUnhealthy: false,
      reason: "Request aborted by caller",
    };
  }

  return {
    kind: "network",
    shouldFailover: true,
    cooldownMs: TRANSIENT_COOLDOWN_MS,
    markUnhealthy: false,
    reason: `Network/transport failure (${describeNetworkError(error)})`,
  };
}
