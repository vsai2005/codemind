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

import { trustedProxyHops } from "@/lib/env";

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

  /**
   * POST /api/repositories — indexing a public GitHub repository.
   *
   * The one bucket here protecting a budget that belongs to EVERYONE. GitHub gives the
   * server ~5,000 requests/hour on a single shared token, so a user indexing
   * repositories in a loop does not just spend their own quota — they drain the pool
   * and every other user's repository features stop working. That is an accidental
   * denial of service, reachable with no intent to abuse and no way for the victims to
   * tell what happened.
   *
   * Deliberately tight, because legitimate use barely touches it: indexing is two API
   * calls and idempotent per commit, so re-indexing an unchanged repository returns the
   * existing snapshot without contacting GitHub at all. Ten an hour is far above real
   * use and far below what could exhaust the pool.
   */
  repositoryIngest: { limit: 10, windowMs: 3_600_000 },

  /**
   * Sign-in attempts for ONE account, keyed by submitted email.
   *
   * This is the bucket that stops password guessing: an attacker targeting an account
   * cannot escape it by changing address or clearing cookies. Ten attempts in five
   * minutes is far above normal mistyping and far below anything useful for a guess.
   *
   * It is deliberately not a lockout — the window rolls, so a legitimate user is
   * delayed at worst and never permanently locked out of their own account.
   */
  authAccount: { limit: 10, windowMs: 300_000 },

  /**
   * Sign-in attempts from one source, keyed by client IP where a trusted proxy makes
   * one available and otherwise shared across all unauthenticated traffic. Bounds
   * total scrypt work — each verification costs ~16MB and ~100ms, so this is what
   * keeps sign-in from being a cheap CPU and memory exhaustion vector.
   *
   * Sized for the shared case: 60/minute caps scrypt at roughly 10% of one core while
   * staying far above what a real user base generates. The per-account bucket above is
   * what actually stops guessing; this one only stops the machine falling over.
   */
  authSource: { limit: 60, windowMs: 60_000 },

  /**
   * POST /api/auth/register — account creation, far rarer than sign-in.
   *
   * Also sized for the shared case, since registration has no session to key on. Set
   * CODEMIND_TRUSTED_PROXY_HOPS to make this per-IP instead of global.
   */
  register: { limit: 20, windowMs: 3_600_000 },
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
 * The client IP, or null when no trustworthy one can be established.
 *
 * `x-forwarded-for` is written by the client and appended to by each proxy, so the
 * only entries worth believing are the ones added by proxies you operate. Reading the
 * LEFTMOST entry — the previous behaviour — reads exactly the part the client wrote,
 * which let a requester mint a fresh rate-limit bucket per request just by varying a
 * header.
 *
 * `CODEMIND_TRUSTED_PROXY_HOPS` states how many proxies sit in front of this app. We
 * count that many entries in from the RIGHT. With the default of 0 the header is
 * ignored entirely: an unconfigured deployment cannot be tricked into trusting a
 * forged address, and callers fall back to a shared bucket instead.
 */
export function clientIp(request: Request): string | null {
  const hops = trustedProxyHops();
  if (hops <= 0) return null;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const index = parts.length - hops;
    if (index >= 0 && index < parts.length) return parts[index];
    // Fewer entries than configured hops: the chain is not what we were told it is.
    return null;
  }

  // Set by a single proxy directly in front of the app; only meaningful for one hop.
  if (hops === 1) {
    const real = request.headers.get("x-real-ip")?.trim();
    if (real) return real;
  }

  return null;
}

/**
 * Stable identity for a requester. Prefers the authenticated user id, which is the
 * only identity that is not client-controlled.
 *
 * When there is no session and no trusted proxy, every unauthenticated requester
 * shares the `source:untrusted` bucket. That is intentional: a shared limit is a
 * denial-of-service risk, but a forgeable per-request limit is no limit at all. Routes
 * that need real protection without a session — sign-in, registration — additionally
 * key on the submitted email, which is the thing being attacked and cannot be varied
 * freely by an attacker targeting one account.
 */
export function identifyRequester(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;
  const ip = clientIp(request);
  return ip ? `ip:${ip}` : "source:untrusted";
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

/**
 * Consume one sign-in attempt.
 *
 * Two buckets, deliberately:
 *
 *   authAccount  keyed on the submitted email — stops guessing at one account, and
 *                cannot be escaped by rotating IP or clearing cookies
 *   authSource   keyed on the requester — bounds total scrypt work, which is the
 *                CPU/memory exhaustion side of the problem
 *
 * Returns a plain result rather than a Response: `authorize()` is a NextAuth callback,
 * not an HTTP handler, and must answer with null so the caller learns nothing about
 * why the attempt failed.
 *
 * Call this BEFORE looking the user up, so a blocked attempt costs no database query
 * and no password verification.
 */
export function consumeAuthAttempt(
  request: Request | undefined,
  email: string
): { ok: boolean; retryAfterSeconds: number } {
  const account = checkRateLimit("authAccount", `email:${email}`);
  const source = checkRateLimit(
    "authSource",
    request ? identifyRequester(request, null) : "source:untrusted"
  );

  return {
    ok: account.ok && source.ok,
    retryAfterSeconds: Math.max(account.retryAfterSeconds, source.retryAfterSeconds),
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
