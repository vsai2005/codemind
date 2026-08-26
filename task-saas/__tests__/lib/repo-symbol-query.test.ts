import { describe, it, expect } from "vitest";
import { queryTerms } from "@/lib/ai/context-manager";
import { scoreFiles, type IndexedFile } from "@/lib/repo/selection";

/**
 * A question naming an indexed symbol by its EXACT name must find it.
 *
 * THE BUG THIS PINS
 * The index split camelCase and the question did not. `pathWords` turned
 * `validateConcurrency` into `validate` + `concurrency`, while `queryTerms` only
 * lowercased and split on `\W+`, producing the single token `validateconcurrency`.
 * The two never met, so an exact symbol-name question scored ZERO files.
 *
 * It looked fine in production because `fallbackFiles` returns entry points when
 * scoring finds nothing, and on a single-file library the entry point IS the right
 * file. The answer was correct by luck. On any repository where the symbol lives
 * outside the entry point, this served the wrong context with no error at all — the
 * exact silent-wrong-answer failure the repository feature exists to avoid.
 *
 * FIXTURE IS REAL DATA. These rows are what `sindresorhus/p-limit` actually produced
 * through the live ingestion pipeline (16 files indexed, commit df476048), not
 * hand-written names chosen to pass. `benchmark.js` exporting nothing and `index.d.ts`
 * carrying the same exported names as `index.js` are both real, and both matter: the
 * first is why internalSymbols has to count, the second is why the declaration penalty
 * has to exist.
 */
const P_LIMIT_INDEX: readonly IndexedFile[] = [
  {
    path: "index.js",
    size: 3315,
    language: "javascript",
    symbols: ["pLimit", "limitFunction"],
    internalSymbols: [
      "validateConcurrency",
      "resumeNext",
      "resolve",
      "next",
      "enqueue",
      "value",
      "set",
      "queueMicrotask",
    ],
  },
  {
    path: "index.d.ts",
    size: 4429,
    language: "typescript",
    symbols: ["pLimit", "limitFunction", "LimitFunction", "Options"],
    internalSymbols: ["limit", "input", "result", "limitedFunction"],
  },
  {
    path: "benchmark.js",
    size: 7741,
    language: "javascript",
    symbols: [],
    internalSymbols: ["cpuIntensiveTask", "ioIntensiveTask", "benchmarker"],
  },
  {
    path: "scripts/benchmarker.js",
    size: 6224,
    language: "javascript",
    symbols: ["benchmarker", "formatResult", "runBenchmark"],
    internalSymbols: ["run", "format", "series", "collect", "report", "warmup", "measure"],
  },
  {
    path: "test.js",
    size: 8764,
    language: "javascript",
    symbols: [],
    internalSymbols: ["test", "delay", "timeSpan"],
  },
];

describe("exact symbol-name questions", () => {
  it("tokenizes a camelCase identifier into its parts AND the whole name", () => {
    const terms = queryTerms("What does validateConcurrency do?");
    expect(terms).toContain("validate");
    expect(terms).toContain("concurrency");
    // The compound is what lets an exact name outrank a coincidental pair of words.
    expect(terms).toContain("validateconcurrency");
  });

  it("scores the file declaring validateConcurrency above zero", () => {
    // The exact repro from the ingestion audit. Scored 0 before the shared tokenizer.
    const scored = scoreFiles(P_LIMIT_INDEX, "What does validateConcurrency do? Cite the file.");

    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].path).toBe("index.js");
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it("finds it without relying on the entry-point fallback", () => {
    // scoreFiles is called directly; fallbackFiles is never consulted. If this only
    // passed through the fallback, the bug would still be present and invisible.
    const scored = scoreFiles(P_LIMIT_INDEX, "how does validateConcurrency reject a bad value");
    expect(scored.map((s) => s.path)).toContain("index.js");
  });

  it("ranks an exact name above the same words spread across another file", () => {
    // scripts/benchmarker.js declares `run`, `format`, `measure`; index.js declares
    // `resumeNext`. A question naming resumeNext must not tie with a file that merely
    // shares one of its halves.
    const scored = scoreFiles(P_LIMIT_INDEX, "how does resumeNext work");
    expect(scored[0].path).toBe("index.js");
  });

  it("still matches when the question spaces the words out", () => {
    // The phrasing that always worked must keep working — the fix adds a path, it does
    // not replace one.
    const scored = scoreFiles(P_LIMIT_INDEX, "what does validate concurrency do");
    expect(scored.map((s) => s.path)).toContain("index.js");
  });

  it("does not invent compounds out of path segments", () => {
    // "src/lib" and "index.js" must not contribute "srclib" or "indexjs" — they name
    // nothing and no question would contain them. Only real identifiers compound.
    const terms = queryTerms("what is in index.js under src/lib");
    expect(terms).not.toContain("indexjs");
    expect(terms).not.toContain("srclib");
    expect(terms).toContain("index");
  });
});
