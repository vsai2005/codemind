import { logger } from "@/lib/logger";

/**
 * In-process cache for repository file contents.
 *
 * WHY THIS EXISTS, measured. A repo-backed turn fetches up to ten files, each one a
 * GitHub request, and nothing remembered them between turns. Three real questions
 * against ky selected `source/core/Ky.ts` twice, `test/hooks.ts` twice and
 * `source/types/options.ts` twice — a user working through one area of a codebase
 * re-downloads the same files on every message.
 *
 * The cost is a shared budget, not a private one. GitHub allows this server ~5,000
 * requests/hour on ONE token for every user, and the chat limit of 20 requests/minute
 * means a single user can now issue 200 file reads a minute. Parallelising the fetch
 * fixed latency and did nothing for that; if anything it made the bursts sharper.
 *
 * INVALIDATION IS FREE, WHICH IS WHY THIS IS SAFE. The key includes the commit SHA, and
 * a blob at a given path in a given commit is immutable by definition — GitHub cannot
 * return different bytes for the same key. There is no staleness window, no TTL to tune
 * and no invalidation logic to get wrong. A new commit produces new keys; the old ones
 * simply age out.
 */

/**
 * Characters of file content held at once, across every repository.
 *
 * SIXTEEN MILLION, sized against the 512MB instance this is written for. V8 stores
 * strings as UTF-16, so the real heap cost is up to twice this — about 32MB worst case,
 * ~6% of the instance. Measured against real content that is generous: ky's source
 * files average under 6KB, so this holds thousands of them, and the working set of one
 * conversation is a few dozen.
 *
 * Counted in CHARACTERS rather than bytes to stay consistent with MAX_FILE_BYTES in
 * github.ts, which also compares against `.length`. Both are approximations of memory;
 * neither pretends otherwise.
 */
export const FILE_CACHE_MAX_CHARS = 16 * 1024 * 1024;

interface Entry {
  content: string;
  chars: number;
  /** Monotonic counter, not a clock: eviction needs an order, not a time. */
  usedAt: number;
}

const entries = new Map<string, Entry>();
let heldChars = 0;
let tick = 0;
let hits = 0;
let misses = 0;

/**
 * A 40-hex SHA-1 or 64-hex SHA-256 object id, and nothing else.
 *
 * Branch names, tags and "HEAD" all resolve differently over time. Anything mutable in
 * that position turns this cache from safe-by-construction into a stale-content bug
 * that only appears after someone pushes — silent, delayed, and near-impossible to
 * reproduce from a report. SHA-256 is accepted because GitHub is migrating to it.
 */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

/**
 * Cache key for one blob, or null when the read must not be cached.
 *
 * THE SAFETY OF THIS WHOLE MODULE IS ONE ASSUMPTION: that the sha position holds an
 * immutable commit id. Every other property follows from it. So it is CHECKED here
 * rather than documented and hoped for — a caller that passes a branch name gets no
 * key, and the read goes to GitHub every time instead of being answered from a cache
 * that can no longer be trusted.
 *
 * REFUSES RATHER THAN THROWS, deliberately. A caching concern must never turn a working
 * request into a failed one: bypassing costs a GitHub call, throwing costs the user
 * their answer. The error log is what makes it loud, and the tests are what make it
 * caught before it ships — this is the same shape as the pool-floor guard in
 * key-scheduler.ts, which also logs and degrades rather than failing the request.
 *
 * Owner and name are in the key because two repositories can share a path, and a fork
 * can share a commit with its upstream.
 */
export function fileCacheKey(
  owner: string,
  name: string,
  commitSha: string,
  path: string
): string | null {
  if (!COMMIT_SHA_RE.test(commitSha)) {
    logger.error("Refusing to cache a repository file under a non-commit ref", {
      owner,
      name,
      // The ref itself, so the offending call site is identifiable. It is a branch or
      // tag name at this point, not a credential.
      ref: commitSha,
      path,
    });
    return null;
  }
  return `${owner}/${name}@${commitSha}:${path}`;
}

/** Cached content, or null. Records the access so eviction can order by recency. */
export function getCachedFile(key: string): string | null {
  const entry = entries.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  entry.usedAt = ++tick;
  hits++;
  return entry.content;
}

/**
 * Store one file, evicting least-recently-used entries until the budget holds.
 *
 * A file larger than the whole budget is NOT stored: admitting it would evict
 * everything else to hold one entry, which is worse than not caching it at all.
 */
export function setCachedFile(key: string, content: string): void {
  const chars = content.length;
  if (chars > FILE_CACHE_MAX_CHARS) return;

  const existing = entries.get(key);
  if (existing) heldChars -= existing.chars;

  entries.set(key, { content, chars, usedAt: ++tick });
  heldChars += chars;

  if (heldChars <= FILE_CACHE_MAX_CHARS) return;

  // Evict oldest-first until under budget. Sorted per eviction rather than kept in a
  // linked list: eviction is rare next to lookup, and a Map of a few thousand entries
  // sorts in well under a millisecond.
  const byAge = Array.from(entries.entries()).sort((a, b) => a[1].usedAt - b[1].usedAt);
  let evicted = 0;
  for (const [oldKey, oldEntry] of byAge) {
    if (heldChars <= FILE_CACHE_MAX_CHARS) break;
    if (oldKey === key) continue; // never evict what was just written
    entries.delete(oldKey);
    heldChars -= oldEntry.chars;
    evicted++;
  }

  if (evicted > 0) {
    logger.debug("Repository file cache evicted entries", {
      evicted,
      remaining: entries.size,
      heldChars,
    });
  }
}

/** Hit/miss counters and current occupancy, for logging and tests. */
export function fileCacheStats(): {
  hits: number;
  misses: number;
  entries: number;
  heldChars: number;
} {
  return { hits, misses, entries: entries.size, heldChars };
}

/**
 * Drop everything. Tests only — the cache is never invalidated in production, because
 * an immutable key cannot go stale.
 */
export function __resetFileCache(): void {
  entries.clear();
  heldChars = 0;
  tick = 0;
  hits = 0;
  misses = 0;
}
