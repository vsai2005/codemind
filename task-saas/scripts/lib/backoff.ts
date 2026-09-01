/**
 * Retry pacing for the measurement script.
 *
 * Pure functions, no side effects, no imports from the script that uses them — so the
 * behaviour can be tested without running a measurement or calling a provider. The
 * schedules were previously inline and therefore only verifiable by producing a real
 * rate limit, which is neither cheap nor reliable.
 *
 * THE FAILURE THIS PACING EXISTS FOR
 * A measurement run lost 22 of 42 turns to "Too Many Requests". The retry loop had no
 * delay: three attempts fired inside one second and every one was rejected. They were
 * not merely ineffective — they were guaranteed to fail, because the gateway had already
 * put the key into cooldown and Gemini has only one key to be in cooldown.
 */

import { RATE_LIMIT_COOLDOWN_MS } from "@/lib/ai/failure-classification";

/**
 * Waits before each retry of a rate-limited call.
 *
 * Derived from the gateway's own cooldown rather than chosen independently, so the two
 * cannot drift apart. A retry that fires before RATE_LIMIT_COOLDOWN_MS has elapsed is
 * asking for a key the scheduler has already parked; the margin above it absorbs clock
 * skew and the tail of the provider's own quota window.
 */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [
  RATE_LIMIT_COOLDOWN_MS + 10_000,
  RATE_LIMIT_COOLDOWN_MS * 2,
  RATE_LIMIT_COOLDOWN_MS * 3,
];

/**
 * Waits before each retry of a transport stall.
 *
 * Deliberately much shorter. A stalled connection recovers on a timescale of seconds,
 * and pausing a minute for one would waste more time than the failure did.
 */
export const TRANSPORT_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000];

/**
 * Does this provider error mean "you are asking too often"?
 *
 * Matched on the message because that is all `generateArtifact` surfaces — it returns a
 * scrubbed string, not a status code. Deliberately broad across the phrasings providers
 * actually use: Google says "Too Many Requests", others say "rate limit" or "quota".
 *
 * A false negative here is cheap: the call is retried on the short schedule and probably
 * fails again. A false positive costs a minute of waiting for a stall that would have
 * cleared in seconds, so the patterns are specific rather than catch-all.
 */
export function looksRateLimited(message: string): boolean {
  return /too many requests|rate.?limit|quota|\b429\b/i.test(message);
}

/**
 * How long to wait before retry `attempt` (0-indexed) of a failure.
 *
 * Beyond the end of a schedule the last entry repeats rather than growing without
 * bound: a measurement that paced itself into hours would be abandoned, and an
 * abandoned run measures nothing.
 */
export function backoffFor(message: string, attempt: number): number {
  const schedule = looksRateLimited(message) ? RATE_LIMIT_BACKOFF_MS : TRANSPORT_BACKOFF_MS;
  return schedule[Math.min(Math.max(attempt, 0), schedule.length - 1)];
}

/**
 * Full jitter over [0.5x, 1.0x].
 *
 * Without it, several failures at the same moment retry at the same moment and rebuild
 * the burst that caused the rate limit. Never returns zero, so a "backoff" can never
 * become an immediate retry — which is the exact bug this module exists to prevent.
 */
export function jittered(ms: number, random: () => number = Math.random): number {
  return Math.max(1, Math.round(ms * (0.5 + random() * 0.5)));
}
