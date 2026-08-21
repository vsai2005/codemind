/**
 * Load-aware scheduler for the pool of NVIDIA API keys.
 *
 * WHY THIS EXISTS
 * The original gateway picked a key with `findIndex(k => k.cooldownUntil <= now)`,
 * which always returns the first eligible slot. With five keys configured, KEY_1
 * absorbed effectively all traffic and only shed load once it had already been
 * rate limited. This module replaces that with least-loaded / least-recently-used
 * selection, so concurrent requests spread across the pool *before* anything 429s.
 *
 * SCOPE AND LIMITATIONS (deliberate, mirrors lib/rate-limit.ts)
 * - All state lives in the process heap. It is accurate for exactly one Node
 *   process, which is what the current single-container deployment runs.
 * - It is NOT shared across horizontally scaled replicas. Each replica would hold
 *   an independent view of activeRequests / cooldowns, so N replicas could each
 *   drive a key up to its own concurrency cap. Making this correct for multi-replica
 *   deployments requires a distributed scheduler (shared counters plus leases with
 *   expiry). That is intentionally out of scope here — no Redis dependency is taken
 *   for this app.
 *
 * SECURITY
 * The key material appears in exactly one place in the public surface: the `secret`
 * field of a KeyLease, which the caller uses only to build an Authorization header.
 * Stats, logs and errors carry only the safe label (KEY_1, KEY_2, ...) and counts.
 * Never add the secret to a log line, an Error message, or getKeyStats().
 */

import type { FailureClassification } from "./failure-classification";
import { logger } from "@/lib/logger";

/**
 * Env slots read, in priority order. Slot order also determines the safe label:
 * the first surviving slot becomes KEY_1, the next KEY_2, and so on. Missing,
 * empty and duplicate values are skipped, so labels are dense and stable for a
 * given environment.
 */
const KEY_ENV_VARS = [
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
  "NVIDIA_API_KEY_3",
  "NVIDIA_API_KEY_4",
  "NVIDIA_API_KEY_5",
  "NVIDIA_API_KEY",
] as const;

/**
 * How many in-flight requests a single key may carry. Four is a conservative
 * default for NVIDIA's hosted endpoints: high enough that a single chat stream
 * plus a couple of background calls never block, low enough that one key does not
 * become the bottleneck that triggers provider-side throttling.
 */
const DEFAULT_MAX_CONCURRENT_PER_KEY = 4;

/** Base cooldown applied to a failing key before its first retry. */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Ceiling for exponential backoff. Beyond 15 minutes a key is effectively parked;
 * going higher only delays recovery after a transient provider incident.
 */
const MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * Cooldown given to a key marked unhealthy (bad credential, revoked key, hard
 * provider rejection). It is a long park, NOT a permanent kill: the key becomes
 * eligible again once the timestamp passes, so a rotated credential recovers
 * without a process restart.
 */
const DISABLED_COOLDOWN_MS = MAX_COOLDOWN_MS;

export interface KeyStats {
  /** Safe label such as "KEY_1". Never the secret. */
  id: string;
  activeRequests: number;
  failureCount: number;
  cooldownUntil: number;
  lastUsedAt: number;
  status: "healthy" | "cooling" | "disabled";
}

export interface KeyLease {
  /** Safe label such as "KEY_1". Never the secret. */
  id: string;
  /** The credential. Use it for the Authorization header and nothing else. */
  secret: string;
  /** Return the concurrency slot after success or final completion. Idempotent. */
  release(): void;
  /**
   * Return the slot for a request that was abandoned rather than completed (a stalled
   * stream reclaimed by a watchdog). Unlike release() this does NOT reset failureCount:
   * an abandoned request is not evidence the key is healthy, so accumulated backoff
   * must survive. Idempotent.
   */
  abandon(): void;
  /** Apply cooldown/health from a classified failure, then release. Idempotent. */
  reportFailure(c: FailureClassification): void;
}

interface KeySlot {
  id: string;
  secret: string;
  activeRequests: number;
  failureCount: number;
  cooldownUntil: number;
  lastUsedAt: number;
  /**
   * Sticky flag set by a failure classified as unhealthy. Cleared automatically
   * once cooldownUntil passes — see `resolveStatus`.
   */
  disabled: boolean;
}

let slots: KeySlot[] | null = null;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxConcurrentPerKey(): number {
  return readPositiveIntEnv("NVIDIA_MAX_CONCURRENT_PER_KEY", DEFAULT_MAX_CONCURRENT_PER_KEY);
}

function baseCooldownMs(): number {
  return readPositiveIntEnv("NVIDIA_KEY_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

/**
 * Build the pool lazily rather than at module import time. Next.js evaluates
 * modules during build and in edge/route bundling where env vars may not yet be
 * populated; reading on first use guarantees we see the runtime environment.
 */
function ensureLoaded(): KeySlot[] {
  if (slots) return slots;

  const seen = new Set<string>();
  const loaded: KeySlot[] = [];

  for (const envVar of KEY_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    loaded.push({
      id: `KEY_${loaded.length + 1}`,
      secret: value,
      activeRequests: 0,
      failureCount: 0,
      cooldownUntil: 0,
      lastUsedAt: 0,
      disabled: false,
    });
  }

  slots = loaded;

  if (loaded.length === 0) {
    logger.error("AI key scheduler found no configured NVIDIA API keys", {
      checkedSlots: KEY_ENV_VARS.length,
    });
  } else {
    logger.info("AI key scheduler initialised", {
      keyCount: loaded.length,
      maxConcurrentPerKey: maxConcurrentPerKey(),
    });
  }

  return loaded;
}

function resolveStatus(slot: KeySlot, now: number): KeyStats["status"] {
  // Both "disabled" and "cooling" are expressed purely as timestamps, so recovery
  // is automatic — nothing here needs a restart or a background timer.
  if (slot.cooldownUntil > now) return slot.disabled ? "disabled" : "cooling";
  return "healthy";
}

/**
 * Cooldown for the n-th consecutive failure of a key: base * failureCount, capped.
 * Linear-on-failure-count backoff (1x, 2x, 3x...) recovers faster than doubling,
 * which matters because most failures here are transient provider 429s rather than
 * a broken key.
 */
function computeCooldownMs(requestedMs: number, failureCount: number): number {
  const base = requestedMs > 0 ? requestedMs : baseCooldownMs();
  return Math.min(base * Math.max(1, failureCount), MAX_COOLDOWN_MS);
}

/**
 * Reserve the least-loaded eligible key, or null when the pool has nothing to give.
 *
 * Selection order:
 *   1. drop keys whose cooldownUntil is still in the future (covers "disabled" too),
 *   2. drop keys named in `excludeIds` — used by a retry to avoid keys already tried
 *      for this same request,
 *   3. drop keys already at the per-key concurrency cap,
 *   4. of what remains, prefer the LOWEST activeRequests,
 *   5. break ties on the OLDEST lastUsedAt, i.e. least-recently-used.
 *
 * Step 5 is what stops the original KEY_1 bias: when every key is idle they all have
 * activeRequests 0, and LRU rotates through them instead of re-picking the first.
 *
 * Returning null is deliberate. This function never queues, blocks, sleeps, or
 * busy-waits — the caller decides whether to retry later, degrade, or surface a 503.
 */
export function acquireKey(excludeIds?: readonly string[]): KeyLease | null {
  const pool = ensureLoaded();
  if (pool.length === 0) return null;

  const now = Date.now();
  const cap = maxConcurrentPerKey();
  const excluded = excludeIds && excludeIds.length > 0 ? new Set(excludeIds) : null;

  // ---------------------------------------------------------------------------
  // RACE-FREE RESERVATION
  // Everything from here to the `chosen.activeRequests += 1` below is synchronous:
  // there is NO `await`, no promise, no callback, no I/O. Node runs one piece of
  // JavaScript at a time and only yields to another task at an await point or at
  // the end of the current tick, so no other caller can observe the intermediate
  // state where a key has been chosen but not yet counted. That is precisely what
  // makes select-then-reserve atomic here, and why the scan and the increment must
  // stay in the same synchronous block. If a future change introduces an `await`
  // between the scan and the increment, two concurrent callers could both pass the
  // capacity check and both take the last slot — so do not add one.
  // ---------------------------------------------------------------------------
  let chosen: KeySlot | null = null;

  for (const slot of pool) {
    if (slot.cooldownUntil > now) continue;
    // Cooldown has elapsed, so an earlier "unhealthy" verdict has served its parking
    // period. Clear the flag here rather than on a timer: the key is eligible again
    // and will be re-marked immediately if it is still bad.
    if (slot.disabled) {
      slot.disabled = false;
      logger.info("AI key scheduler re-enabled key after cooldown", { key: slot.id });
    }
    if (excluded?.has(slot.id)) continue;
    if (slot.activeRequests >= cap) continue;

    if (
      chosen === null ||
      slot.activeRequests < chosen.activeRequests ||
      (slot.activeRequests === chosen.activeRequests && slot.lastUsedAt < chosen.lastUsedAt)
    ) {
      chosen = slot;
    }
  }

  if (chosen === null) {
    logger.warn("AI key scheduler had no eligible key", {
      keyCount: pool.length,
      excludedCount: excluded ? excluded.size : 0,
    });
    return null;
  }

  chosen.activeRequests += 1;
  chosen.lastUsedAt = now;
  // --- end of the atomic region ---

  const slot = chosen;
  // Guards idempotency for both release() and reportFailure(): a stream can complete
  // and then also be cancelled, and both paths call into the lease.
  let settled = false;

  const releaseSlot = (): void => {
    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
  };

  return {
    id: slot.id,
    secret: slot.secret,
    release(): void {
      if (settled) return;
      settled = true;
      // A completed request is the only proof a key is actually working, so this is
      // where the consecutive-failure counter (and hence the backoff) resets.
      slot.failureCount = 0;
      releaseSlot();
    },
    abandon(): void {
      if (settled) return;
      settled = true;
      // Deliberately does not touch failureCount — see the interface doc.
      releaseSlot();
    },
    reportFailure(c: FailureClassification): void {
      if (settled) return;
      settled = true;

      slot.failureCount += 1;

      // Pool-floor guard: never disable the last usable key. A content-triggered
      // auth-shaped rejection could otherwise take every key out of rotation at once
      // and black out the whole app. Degrade to a transient cooldown and escalate
      // loudly instead — a total pool wipe should reach a human, not silently 503.
      const wouldWipePool =
        c.markUnhealthy && pool.filter((s) => !s.disabled || s === slot).length <= 1;

      if (wouldWipePool) {
        logger.error("Refusing to disable the last available AI key", {
          key: slot.id,
          failureCount: slot.failureCount,
        });
      }

      if (c.markUnhealthy && !wouldWipePool) {
        slot.disabled = true;
        slot.cooldownUntil = Date.now() + DISABLED_COOLDOWN_MS;
      } else {
        slot.disabled = false;
        slot.cooldownUntil = Date.now() + computeCooldownMs(c.cooldownMs, slot.failureCount);
      }

      logger.warn("AI key scheduler cooling down key after failure", {
        key: slot.id,
        failureCount: slot.failureCount,
        cooldownMs: slot.cooldownUntil - Date.now(),
        markUnhealthy: c.markUnhealthy === true,
      });

      releaseSlot();
    },
  };
}

/** Snapshot for health endpoints and diagnostics. Contains no key material. */
export function getKeyStats(): KeyStats[] {
  const now = Date.now();
  return ensureLoaded().map((slot) => ({
    id: slot.id,
    activeRequests: slot.activeRequests,
    failureCount: slot.failureCount,
    cooldownUntil: slot.cooldownUntil,
    lastUsedAt: slot.lastUsedAt,
    status: resolveStatus(slot, now),
  }));
}

/** Number of distinct keys the environment actually provided (0 is valid). */
export function configuredKeyCount(): number {
  return ensureLoaded().length;
}

/** Test-only: drop the pool so the next call re-reads process.env. */
export function __resetScheduler(): void {
  slots = null;
}
