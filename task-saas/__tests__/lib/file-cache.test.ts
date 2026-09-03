import { describe, it, expect, beforeEach } from "vitest";
import {
  fileCacheKey,
  getCachedFile,
  setCachedFile,
  fileCacheStats,
  __resetFileCache,
  FILE_CACHE_MAX_CHARS,
} from "@/lib/repo/file-cache";

/**
 * The repository file content cache.
 *
 * WHY IT EXISTS. A repo-backed turn fetches up to ten files and nothing remembered them
 * between turns: across three real ky questions, three separate files were each selected
 * twice and downloaded twice. At 20 chat requests/minute that is up to 200 GitHub reads
 * a minute against a pool of ~5,000/hour shared by every user.
 *
 * WHY IT IS SAFE. The key carries the commit SHA, and a blob at a path in a commit is
 * immutable — GitHub cannot return different bytes for the same key. There is no TTL to
 * tune and no invalidation to get wrong, which is the whole reason this is worth doing
 * rather than a thing to be nervous about.
 *
 * Sizes below are LITERAL characters. A fixture derived from FILE_CACHE_MAX_CHARS would
 * move with a mutation of it and prove nothing.
 */

beforeEach(() => __resetFileCache());

/** ky's real indexed commit, and ms's — both 40-hex, both literal. */
const KY_SHA = "d27ad21266d162ee218d4ea69dce192b84b6f967";
const MS_SHA = "4ff48cec099f0514c3e9bbca18706c9c21122bfb";

/**
 * fileCacheKey returns null for anything that is not a commit id, so every helper here
 * asserts non-null: a test that silently cached under a null key would prove nothing.
 */
const key = (path: string, sha = KY_SHA): string => {
  const k = fileCacheKey("sindresorhus", "ky", sha, path);
  if (k === null) throw new Error(`fixture used a non-SHA ref: ${sha}`);
  return k;
};

describe("keying", () => {
  it("separates the same path at different commits", () => {
    // THE PROPERTY THE WHOLE DESIGN RESTS ON. If these collided, a cache hit could
    // return content from a different revision of the file.
    expect(key("src/a.ts", KY_SHA)).not.toBe(key("src/a.ts", MS_SHA));
  });

  it("separates the same path in different repositories", () => {
    // A fork can share a commit SHA with its upstream, so the SHA alone is not enough.
    expect(fileCacheKey("a", "repo", KY_SHA, "src/x.ts")).not.toBe(
      fileCacheKey("b", "repo", KY_SHA, "src/x.ts")
    );
    expect(fileCacheKey("o", "one", KY_SHA, "src/x.ts")).not.toBe(
      fileCacheKey("o", "two", KY_SHA, "src/x.ts")
    );
  });

  it("separates different paths", () => {
    expect(key("src/a.ts")).not.toBe(key("src/b.ts"));
  });
});

describe("storing and reading", () => {
  it("returns what was stored", () => {
    setCachedFile(key("src/a.ts"), "export const a = 1;");

    expect(getCachedFile(key("src/a.ts"))).toBe("export const a = 1;");
  });

  it("returns null for something never stored", () => {
    expect(getCachedFile(key("src/missing.ts"))).toBeNull();
  });

  it("counts hits and misses separately", () => {
    setCachedFile(key("src/a.ts"), "x");
    getCachedFile(key("src/a.ts"));
    getCachedFile(key("src/a.ts"));
    getCachedFile(key("src/nope.ts"));

    expect(fileCacheStats().hits).toBe(2);
    expect(fileCacheStats().misses).toBe(1);
  });

  it("overwrites without double-counting the budget", () => {
    // A re-store of the same key must replace, not accumulate — otherwise the held
    // total drifts upward and eviction fires early for no reason.
    setCachedFile(key("src/a.ts"), "a".repeat(1000));
    setCachedFile(key("src/a.ts"), "b".repeat(10));

    expect(fileCacheStats().heldChars).toBe(10);
    expect(fileCacheStats().entries).toBe(1);
    expect(getCachedFile(key("src/a.ts"))).toBe("b".repeat(10));
  });

  it("stores an empty file as a hit, not a miss", () => {
    // An empty file is a legitimate answer. Treating "" as absent would re-fetch it on
    // every turn forever.
    setCachedFile(key("src/empty.ts"), "");

    expect(getCachedFile(key("src/empty.ts"))).toBe("");
    expect(fileCacheStats().hits).toBe(1);
  });
});

describe("the memory budget", () => {
  it("evicts the least recently used first", () => {
    /**
     * BY CONSTRUCTION. Three entries of 7,000,000 characters each cannot coexist under
     * a 16,777,216-character budget: the third forces an eviction. "a" is touched after
     * both are stored, so "b" is the oldest by use and must be the one dropped —
     * insertion order alone would have dropped "a".
     */
    const big = "x".repeat(7_000_000);
    setCachedFile(key("a.ts"), big);
    setCachedFile(key("b.ts"), big);
    getCachedFile(key("a.ts")); // "a" is now more recently used than "b"
    setCachedFile(key("c.ts"), big);

    expect(getCachedFile(key("b.ts"))).toBeNull();
    expect(getCachedFile(key("a.ts"))).toBe(big);
    expect(getCachedFile(key("c.ts"))).toBe(big);
  });

  it("never holds more than the budget", () => {
    const big = "y".repeat(3_000_000);
    for (let i = 0; i < 12; i++) setCachedFile(key(`f${i}.ts`), big);

    expect(fileCacheStats().heldChars).toBeLessThanOrEqual(16_777_216);
    expect(fileCacheStats().entries).toBeLessThan(12);
  });

  it("keeps the entry it just wrote", () => {
    // Eviction must not be able to drop the value it was triggered by, or a large
    // store would evict itself and every read after it would miss.
    const big = "z".repeat(9_000_000);
    setCachedFile(key("first.ts"), big);
    setCachedFile(key("second.ts"), big);

    expect(getCachedFile(key("second.ts"))).toBe(big);
  });

  it("refuses a file larger than the entire budget", () => {
    // Admitting it would evict everything else to hold one entry, which is worse than
    // not caching it.
    const enormous = "q".repeat(16_777_217);
    setCachedFile(key("huge.ts"), enormous);

    expect(getCachedFile(key("huge.ts"))).toBeNull();
    expect(fileCacheStats().entries).toBe(0);
    expect(fileCacheStats().heldChars).toBe(0);
  });

  it("ships a budget sized for the instance, not unbounded", () => {
    expect(FILE_CACHE_MAX_CHARS).toBe(16 * 1024 * 1024);
  });
});

describe("refusing a mutable ref", () => {
  /**
   * THE ASSUMPTION THE WHOLE MODULE RESTS ON, made enforceable.
   *
   * The key is only safe because a blob at a path in a COMMIT is immutable. A branch
   * name, tag or "HEAD" in that position resolves to different content over time, so a
   * cache built on one would serve the pre-push file silently after every push — a
   * failure that appears late, only in production, and only to whoever pushed.
   *
   * Every ref below is a LITERAL string, not derived from the regex under test.
   */
  for (const ref of ["main", "HEAD", "master", "v1.2.3", "refs/heads/main", "", "develop"]) {
    it(`refuses to key on "${ref}"`, () => {
      expect(fileCacheKey("sindresorhus", "ky", ref, "src/a.ts")).toBeNull();
    });
  }

  it("refuses a truncated short SHA", () => {
    // Short SHAs are ambiguous by design — GitHub can resolve the same abbreviation to
    // a different commit once the repository grows.
    expect(fileCacheKey("sindresorhus", "ky", "d27ad21", "src/a.ts")).toBeNull();
    expect(fileCacheKey("sindresorhus", "ky", "d27ad21266d162ee", "src/a.ts")).toBeNull();
  });

  it("refuses a ref that merely CONTAINS a valid SHA", () => {
    /**
     * ADDED AFTER MUTATION TESTING: an unanchored pattern survived the whole suite,
     * because every fixture was either a clean SHA or contained no hex run at all.
     *
     * These are the shapes an unanchored match would wave through, and both are real:
     * a branch cut from a commit and named after it, and a tag suffixed onto one. Both
     * are mutable, and both would be cached under a key that looks immutable.
     */
    expect(fileCacheKey("o", "n", `refs/heads/${KY_SHA}`, "a.ts")).toBeNull();
    expect(fileCacheKey("o", "n", `${KY_SHA}-backup`, "a.ts")).toBeNull();
    expect(fileCacheKey("o", "n", ` ${KY_SHA}`, "a.ts")).toBeNull();
    expect(fileCacheKey("o", "n", `${KY_SHA}
`, "a.ts")).toBeNull();
  });

  it("refuses a 40-character string that is not hex", () => {
    // Right length, wrong alphabet: a branch name padded to 40 characters is still a
    // branch name.
    expect(fileCacheKey("sindresorhus", "ky", "z".repeat(40), "src/a.ts")).toBeNull();
    expect(fileCacheKey("sindresorhus", "ky", "main-".padEnd(40, "x"), "src/a.ts")).toBeNull();
  });

  it("accepts a 40-hex SHA-1", () => {
    expect(fileCacheKey("sindresorhus", "ky", KY_SHA, "src/a.ts")).toBe(
      `sindresorhus/ky@${KY_SHA}:src/a.ts`
    );
  });

  it("accepts a 64-hex SHA-256, which GitHub is migrating to", () => {
    const sha256 = "a".repeat(64);

    expect(fileCacheKey("o", "n", sha256, "p.ts")).toBe(`o/n@${sha256}:p.ts`);
  });

  it("accepts an uppercase SHA", () => {
    expect(fileCacheKey("o", "n", KY_SHA.toUpperCase(), "p.ts")).not.toBeNull();
  });

  it("nothing is stored when the ref is refused", () => {
    // The end-to-end consequence: a refused key means the read is simply not cached,
    // never cached under a wrong key.
    __resetFileCache();
    const k = fileCacheKey("sindresorhus", "ky", "main", "src/a.ts");

    expect(k).toBeNull();
    expect(fileCacheStats().entries).toBe(0);
  });
});
