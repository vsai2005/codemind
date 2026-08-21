/**
 * Lightweight in-memory rate limiter for expensive endpoints.
 *
 * Scope and limitations (deliberate, see README "Rate limits"):
 * - State lives in the process heap. With the current single-container Docker/local
 *   deployment that is exactly one counter set, which is what we want.
 * - It is NOT shared across horizontally scaled replicas. If this app is ever run
 *   with more than one instance, each instance enforces its own share of the limit.
 *   That is an accepted trade-off to avoid taking a Redis dependency for a demo app.
 *
 * Set CODEMIND_DISABLE_RATE_LIMIT=true to turn the limiter off entirely (local
 * development / load testing only).
 */

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/**
 * Per-bucket limits. Sized so that ordinary interactive use never trips them,
 * while an accidental loop or a script is stopped quickly.
 */
export const RATE_LIMITS = {
  /** POST /api/chat — each request may trigger a full model generation. */
  chat: { limit: 20, windowMs: 60_000 },
  /** POST /api/upload — PDF/text parsing is CPU bound. */
  upload: { limit: 30, windowMs: 60_000 },
  /** POST /api/export/* — ZIP/PDF construction. */
  export: { limit: 30, windowMs: 60_000 },
  /** GET /api/artifacts/:id/download — cheap, re-reads a stored artifact. */
  download: { limit: 60, windowMs: 60_000 },
  /** Project CRUD — cheap DB writes, but still worth bounding. */
  projects: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60_000;

/** Drop expired counters so the map cannot grow without bound. */
function sweepExpired(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, counter] of Array.from(counters.entries())) {
    if (counter.resetAt <= now) counters.delete(key);
  }
}

function isDisabled(): boolean {
  return process.env.CODEMIND_DISABLE_RATE_LIMIT === "true";
}

/**
 * Stable identity for a requester. Prefers the authenticated user id; falls back to
 * the proxy-forwarded client IP for unauthenticated traffic.
 *
 * Note: the IP fallback trusts `x-forwarded-for`, which is only meaningful behind a
 * trusted proxy. Authenticated routes always pass a userId, so the fallback is a
 * best-effort backstop rather than a security control.
 */
export function identifyRequester(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

export function checkRateLimit(
  bucket: RateLimitBucket,
  identity: string,
  now: number = Date.now()
): RateLimitResult {
  const rule = RATE_LIMITS[bucket];

  if (isDisabled()) {
    return {
      ok: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetAt: now + rule.windowMs,
      retryAfterSeconds: 0,
    };
  }

  sweepExpired(now);

  const key = `${bucket}:${identity}`;
  const existing = counters.get(key);

  if (!existing || existing.resetAt <= now) {
    const counter: Counter = { count: 1, resetAt: now + rule.windowMs };
    counters.set(key, counter);
    return {
      ok: true,
      limit: rule.limit,
      remaining: rule.limit - 1,
      resetAt: counter.resetAt,
      retryAfterSeconds: 0,
    };
  }

  existing.count += 1;
  const remaining = Math.max(0, rule.limit - existing.count);
  const ok = existing.count <= rule.limit;

  return {
    ok,
    limit: rule.limit,
    remaining,
    resetAt: existing.resetAt,
    retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.ok) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

/** Standard 429 for a tripped limit. */
export function rateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    {
      error: "Rate limit exceeded. Please slow down and try again shortly.",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    { status: 429, headers: rateLimitHeaders(result) }
  );
}

/**
 * Enforce a limit in one call. Returns a 429 Response when the caller should stop,
 * or null when the request may proceed.
 */
export function enforceRateLimit(
  bucket: RateLimitBucket,
  request: Request,
  userId?: string | null
): Response | null {
  const result = checkRateLimit(bucket, identifyRequester(request, userId));
  return result.ok ? null : rateLimitResponse(result);
}

// ---------------------------------------------------------------------------
// Concurrent generation slots
// ---------------------------------------------------------------------------

/**
 * Maximum simultaneous in-flight AI generations per user.
 *
 * The request-rate limit above does not bound CONCURRENCY, and an AI generation holds
 * a provider key for as long as it streams. Without this cap, one user slow-reading
 * their SSE streams could hold every key in the pool and lock every other user out —
 * the rate limit would not stop them, because opening streams is cheap and they never
 * finish. This is the control that keeps one identity from monopolising a shared pool.
 */
const MAX_CONCURRENT_GENERATIONS_PER_USER = 3;

const inFlight = new Map<string, number>();

/**
 * Reserve a generation slot for `userId`. Returns a release function, or null when the
 * user is already at their concurrency limit.
 *
 * The returned function is idempotent: a stream can both complete and be cancelled, and
 * releasing twice must not free a slot the user no longer holds.
 */
export function acquireGenerationSlot(userId: string): (() => void) | null {
  if (process.env.CODEMIND_DISABLE_RATE_LIMIT === "true") return () => undefined;

  const current = inFlight.get(userId) ?? 0;
  if (current >= MAX_CONCURRENT_GENERATIONS_PER_USER) return null;

  inFlight.set(userId, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inFlight.get(userId) ?? 1) - 1;
    if (remaining <= 0) inFlight.delete(userId);
    else inFlight.set(userId, remaining);
  };
}

export function concurrentGenerationLimit(): number {
  return MAX_CONCURRENT_GENERATIONS_PER_USER;
}

/** Test-only: clear all counters between cases. */
export function __resetRateLimits(): void {
  counters.clear();
  inFlight.clear();
  lastSweepAt = 0;
}
