import { describe, it, expect } from "vitest";
import { fallbackFiles, scoreFiles, type IndexedFile } from "@/lib/repo/selection";

/**
 * Defense in depth for the language filter.
 *
 * The route's Prisma query asks for `NOT: { language: null }`, and until now that was
 * the ONLY thing standing between selection and a README. Nothing in this module
 * re-checked it, so any future caller that forgot the clause would silently spend a
 * GitHub request and a share of the context budget fetching prose instead of code —
 * with no error, and a confident answer built on the wrong material.
 *
 * These assertions are deliberately made against the selection functions directly,
 * with unfiltered input, because that is exactly the caller mistake being guarded
 * against. The query-level test in __tests__/api/chat-repository-files.test.ts still
 * asserts the clause is sent; this is the second layer, not a replacement.
 *
 * `language: null` is the indexer's own verdict that a file has no recognised source
 * extension — see languageForPath in lib/repo/structure.ts. It covers README files,
 * lockfiles, licences, dotfiles and every binary. On the real p-limit ingestion it was
 * 10 of the 16 indexed rows.
 */

/** A README that OUTRANKS the code on the fallback's own ordering: shallower, bigger. */
const README: IndexedFile = {
  path: "readme.md",
  size: 4972,
  language: null,
  symbols: [],
  internalSymbols: [],
};

const LOCKFILE: IndexedFile = {
  path: "package-lock.json",
  size: 90_000,
  language: null,
  symbols: [],
  internalSymbols: [],
};

const CODE: IndexedFile = {
  path: "source/core/limit.js",
  size: 3315,
  language: "javascript",
  symbols: ["pLimit"],
  internalSymbols: ["validateConcurrency"],
};

describe("selection refuses files with no recognised language", () => {
  describe("fallbackFiles", () => {
    it("never returns a null-language file, even when it wins the ordering", () => {
      // fallbackFiles sorts by depth then size. readme.md is at the root and larger
      // than the code file nested under source/core, so without a guard it is chosen
      // FIRST — this is not a hypothetical ordering, it is the actual one.
      const chosen = fallbackFiles([README, LOCKFILE, CODE], [], 3);

      expect(chosen.map((c) => c.path)).not.toContain("readme.md");
      expect(chosen.map((c) => c.path)).not.toContain("package-lock.json");
      expect(chosen.map((c) => c.path)).toContain("source/core/limit.js");
    });

    it("refuses a null-language file even when it is named as an entry point", () => {
      // structure.entryPoints comes from the indexed tree and is not language-checked
      // where it is built, so a repository whose entry point resolves to a non-source
      // file must still not surface one here.
      const chosen = fallbackFiles([README, CODE], ["readme.md"], 2);

      expect(chosen.map((c) => c.path)).not.toContain("readme.md");
    });

    it("returns nothing rather than prose when every candidate is unrecognised", () => {
      // Empty is the honest answer. Returning a README would produce an answer that
      // sounds grounded and is not.
      expect(fallbackFiles([README, LOCKFILE], [], 3)).toEqual([]);
    });
  });

  describe("scoreFiles", () => {
    it("never scores a null-language file, even when the question names it", () => {
      // "readme" matches readme.md's basename, which is worth BASENAME_WEIGHT plus a
      // coverage bonus — comfortably above zero, so it is returned without a guard.
      const scored = scoreFiles([README, CODE], "what does the readme say about limits");

      expect(scored.map((s) => s.path)).not.toContain("readme.md");
    });

    it("still scores real source files normally", () => {
      // The guard must not cost the case it exists to protect.
      const scored = scoreFiles([README, CODE], "how does validateConcurrency work");

      expect(scored.length).toBeGreaterThan(0);
      expect(scored[0].path).toBe("source/core/limit.js");
    });
  });
});
