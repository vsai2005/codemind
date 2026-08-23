import { describe, it, expect } from "vitest";
import { scoreFiles, type IndexedFile } from "@/lib/repo/selection";

/**
 * The case that justified symbol extraction, kept as the acceptance test.
 *
 * Measured on sindresorhus/is-plain-obj: asking "how does this library decide whether
 * a value is a plain object?" scored ZERO files. The question names a BEHAVIOUR, and
 * the answer lives in index.js, whose path contains none of its words. Nothing in a
 * file LIST can connect them — that is the ceiling of path-only selection.
 *
 * The entry-point fallback made that question answerable, but only by luck: index.js
 * happens to be the entry point of a single-file library. In any larger repository the
 * relevant file is not the entry point, so the fallback would have returned the wrong
 * files just as confidently.
 *
 * These tests therefore assert selection WITHOUT the fallback. If they only pass with
 * it enabled, symbol extraction has not done its job.
 */

/** The real file list from that repository, with its real exported symbol. */
const IS_PLAIN_OBJ: IndexedFile[] = [
  { path: "index.js", size: 344, language: "javascript", symbols: ["isPlainObject"] },
  { path: "index.d.ts", size: 402, language: "typescript", symbols: ["isPlainObject"] },
  { path: "index.test-d.ts", size: 289, language: "typescript", symbols: [] },
  { path: "test.js", size: 1321, language: "javascript", symbols: [] },
  { path: "benchmark.js", size: 1141, language: "javascript", symbols: [] },
];

const BEHAVIOUR_QUESTION = "How does this library decide whether a value is a plain object?";

describe("symbol-aware file selection", () => {
  it("finds the implementation from a question that names behaviour, not filenames", () => {
    // The whole point. None of "library", "decide", "whether", "value", "plain" or
    // "object" appears in any path; all of it appears in the symbol isPlainObject once
    // that is split on camelCase.
    const scored = scoreFiles(IS_PLAIN_OBJ, BEHAVIOUR_QUESTION);

    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].path).toBe("index.js");
  });

  it("ranks the file that exports the symbol above files that merely mention it", () => {
    // test.js imports and exercises isPlainObject but does not export it. A question
    // about how something WORKS should land on the implementation, not the test.
    const scored = scoreFiles(IS_PLAIN_OBJ, BEHAVIOUR_QUESTION);
    const paths = scored.map((s) => s.path);

    expect(paths.indexOf("index.js")).toBeLessThan(
      paths.indexOf("test.js") === -1 ? Number.MAX_SAFE_INTEGER : paths.indexOf("test.js")
    );
  });

  it("beats a path match when the symbol is the better evidence", () => {
    // A file named for the domain but exporting nothing relevant must not outrank the
    // file that actually implements the thing being asked about.
    const files: IndexedFile[] = [
      { path: "src/object.js", size: 200, language: "javascript", symbols: ["formatDate"] },
      { path: "src/util.js", size: 200, language: "javascript", symbols: ["isPlainObject"] },
    ];

    const scored = scoreFiles(files, BEHAVIOUR_QUESTION);
    expect(scored[0].path).toBe("src/util.js");
  });

  it("splits camelCase and PascalCase symbols into their words", () => {
    const files: IndexedFile[] = [
      { path: "a.ts", size: 100, language: "typescript", symbols: ["ConnectionPoolManager"] },
      { path: "b.ts", size: 100, language: "typescript", symbols: ["unrelatedThing"] },
    ];

    const scored = scoreFiles(files, "how is the connection pool managed?");
    expect(scored[0].path).toBe("a.ts");
  });

  it("still works for files with no symbols recorded", () => {
    // Repositories indexed before symbol extraction, or whose tarball fetch failed,
    // carry no symbols. Path scoring must keep working unchanged for them.
    const files: IndexedFile[] = [
      { path: "src/auth/session.ts", size: 500, language: "typescript", symbols: [] },
      { path: "src/render.ts", size: 500, language: "typescript", symbols: [] },
    ];

    const scored = scoreFiles(files, "where is the session handling?");
    expect(scored[0].path).toBe("src/auth/session.ts");
  });
});
