import { describe, it, expect } from "vitest";
import { scoreFiles, selectWithinBudget, type IndexedFile } from "@/lib/repo/selection";

/**
 * The second measured ceiling: a file whose meaning lives in names it does not export.
 *
 * sindresorhus/ky, asked "what happens to the request body when ky retries a request?"
 * — source/core/Ky.ts scored NOT AT ALL. It is 37,849 bytes, the largest source file
 * in the repository, contains the entire retry loop, and exports exactly one symbol:
 * `Ky`. Its path words are source/core/ky. Nothing in the question touches any of that.
 *
 * Selection instead returned source/utils/body.ts, source/types/request.ts and
 * test/helpers/parse-body.ts — all genuinely about request bodies, none about retries —
 * and the model correctly reported that the retry logic was not in the files it was
 * given. Not a wrong answer, but a thin one, built from the wrong evidence.
 *
 * Fetching Ky.ts showed the evidence was there all along: it DECLARES calculateRetryDelay,
 * retryRequest, cloneRetryOptions, cancelBody, raceBodyRead, getBodyReadTimeout. A file's
 * internal names say what it does; we were only indexing its public contract.
 *
 * The fixtures below carry the REAL symbols and REAL byte sizes measured from that
 * repository, so these tests reproduce the failure without a network call.
 */

/** Exactly the question that failed. */
const CEILING_QUESTION = "What happens to the request body when ky retries a request?";

/**
 * The ky files that matter for this question, with measured sizes and symbols.
 * `internalSymbols` are class members and top-level declarations — NOT local bindings
 * inside function bodies, which name nothing about the file's purpose.
 */
const KY: IndexedFile[] = [
  {
    path: "source/core/Ky.ts",
    size: 37849,
    language: "typescript",
    symbols: ["Ky"],
    internalSymbols: [
      "calculateRetryDelay",
      "retryRequest",
      "cloneRetryOptions",
      "consumeReturnedResponseFromBeforeRetryHook",
      "cancelBody",
      "raceBodyRead",
      "getBodyReadTimeout",
      "cancelResponseBody",
      "wrapRequestWithUploadProgress",
      "runBeforeRequestHooks",
    ],
  },
  {
    path: "source/utils/body.ts",
    size: 4200,
    language: "typescript",
    symbols: ["getBodySize", "streamResponse", "streamRequest"],
    internalSymbols: ["withProgress"],
  },
  {
    path: "source/types/request.ts",
    size: 1800,
    language: "typescript",
    symbols: ["KyRequest"],
    internalSymbols: [],
  },
  {
    path: "test/helpers/parse-body.ts",
    size: 900,
    language: "typescript",
    symbols: ["parseJsonBody", "parseRawBody"],
    internalSymbols: [],
  },
  {
    path: "source/core/constants.ts",
    size: 8435,
    language: "typescript",
    symbols: ["RetryMarker", "supportsRequestStreams", "supportsAbortController"],
    internalSymbols: [],
  },
];

describe("selection reaches files through their internal declarations", () => {
  it("puts the file containing the retry loop into the fetched set", () => {
    // THE ACCEPTANCE TEST. Fallback deliberately not involved: scoreFiles alone must
    // find it, or nothing has changed except which lucky default we fall back to.
    const scored = scoreFiles(KY, CEILING_QUESTION);
    const fetched = selectWithinBudget(scored, 20_000, 3).map((f) => f.path);

    expect(fetched).toContain("source/core/Ky.ts");
  });

  it("ranks the file covering all three concepts above the file covering two", () => {
    // body.ts genuinely matches "body" and "request". Ky.ts matches those AND "retries".
    // Coverage of distinct query terms is the thing that should separate them — not the
    // number of times any one term appears.
    const scored = scoreFiles(KY, CEILING_QUESTION);
    const paths = scored.map((s) => s.path);

    expect(paths.indexOf("source/core/Ky.ts")).toBeLessThan(paths.indexOf("source/utils/body.ts"));
  });

  describe("guard: this must not become a size heuristic", () => {
    it("does not promote a large file whose declarations match nothing", () => {
      // The guard that matters most. Ky.ts is the largest source file in ky, so a
      // byte-count bonus would ALSO make the primary test pass — and would be wrong.
      // This file is five times larger again and declares nothing relevant.
      const withBigIrrelevant: IndexedFile[] = [
        ...KY,
        {
          path: "source/generated/schema-types.ts",
          size: 190_000,
          language: "typescript",
          symbols: ["GeneratedSchema"],
          internalSymbols: ["buildEnumTable", "mapScalarKind"],
        },
      ];

      const scored = scoreFiles(withBigIrrelevant, CEILING_QUESTION);
      const fetched = selectWithinBudget(scored, 20_000, 3).map((f) => f.path);

      expect(fetched).not.toContain("source/generated/schema-types.ts");
      expect(scored.some((s) => s.path === "source/generated/schema-types.ts")).toBe(false);
    });

    it("ranks a small matching file above a huge non-matching one", () => {
      const files: IndexedFile[] = [
        { path: "a/huge.ts", size: 500_000, language: "typescript", symbols: [], internalSymbols: [] },
        {
          path: "b/tiny.ts",
          size: 120,
          language: "typescript",
          symbols: [],
          internalSymbols: ["retryRequest"],
        },
      ];

      const scored = scoreFiles(files, CEILING_QUESTION);
      expect(scored[0].path).toBe("b/tiny.ts");
    });
  });

  describe("guard: an exported name is stronger evidence than an internal one", () => {
    it("prefers the file that exports the symbol over the file that only declares it", () => {
      const files: IndexedFile[] = [
        {
          path: "src/exporter.ts",
          size: 500,
          language: "typescript",
          symbols: ["parseConfig"],
          internalSymbols: [],
        },
        {
          path: "src/decliner.ts",
          size: 500,
          language: "typescript",
          symbols: [],
          internalSymbols: ["parseConfig"],
        },
      ];

      const scored = scoreFiles(files, "where is the config parsing done?");
      expect(scored[0].path).toBe("src/exporter.ts");
    });
  });

  describe("guard: the is-plain-obj case still passes", () => {
    it("finds the implementation by its exported symbol", () => {
      const files: IndexedFile[] = [
        { path: "index.js", size: 344, language: "javascript", symbols: ["isPlainObject"], internalSymbols: [] },
        { path: "index.d.ts", size: 402, language: "typescript", symbols: ["isPlainObject"], internalSymbols: [] },
        { path: "test.js", size: 1321, language: "javascript", symbols: [], internalSymbols: [] },
      ];

      const scored = scoreFiles(files, "How does this library decide whether a value is a plain object?");
      expect(scored[0].path).toBe("index.js");
    });
  });

  describe("stemming control", () => {
    it("matches a plural question against a singular declaration", () => {
      // "retries" in the question, "retry" in the code. Exact matching misses this, and
      // it is the term that discriminates Ky.ts from body.ts.
      const files: IndexedFile[] = [
        { path: "a.ts", size: 100, language: "typescript", symbols: [], internalSymbols: ["retryRequest"] },
        { path: "b.ts", size: 100, language: "typescript", symbols: [], internalSymbols: ["formatDate"] },
      ];

      const scored = scoreFiles(files, "how many times does it retries before giving up?");
      expect(scored[0]?.path).toBe("a.ts");
    });

    it("does NOT merge words that merely share a prefix", () => {
      // The failure mode of naive stemming: request/require, policy/police. A stem that
      // collapses these makes every question match more files and scores nothing well.
      const files: IndexedFile[] = [
        { path: "src/require-loader.ts", size: 100, language: "typescript", symbols: ["requireModule"], internalSymbols: [] },
        { path: "src/http.ts", size: 100, language: "typescript", symbols: ["sendRequest"], internalSymbols: [] },
      ];

      const scored = scoreFiles(files, "how is a request sent?");
      expect(scored[0].path).toBe("src/http.ts");
      expect(scored.some((s) => s.path === "src/require-loader.ts")).toBe(false);
    });
  });
});
