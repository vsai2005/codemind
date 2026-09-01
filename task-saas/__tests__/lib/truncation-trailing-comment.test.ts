import { describe, it, expect } from "vitest";
import { findTruncation } from "@/lib/artifacts/validate";

/**
 * Files that end in a closing block comment.
 *
 * THE BUG THIS PINS DOWN, and it refused real work.
 * DANGLING_RE lists trailing tokens that cannot legally end a source file, and its
 * character class contains both the star and the slash. So a file whose last line
 * closed a block comment matched it and was reported as "ends mid-statement".
 *
 * Measured on a 42-generation run: three of three single-file artifacts that reached
 * validation were rejected this way, every one a complete file ending in a trailing
 * JSDoc or a commented-out usage example. Those were the ONLY artifacts to reach the
 * checker on a case expected to pass — so the observed false-positive rate on that path
 * was 100%.
 *
 * FIXTURES ARE ADVERSARIAL. The genuinely-truncated cases below end in operators that
 * are visually close to the legal ones — a bare slash, a bare star, a star followed by
 * something else — so an over-broad exclusion cannot pass by being vaguely right.
 */

/** A complete file, varying only in how its final line ends. */
const withEnding = (ending: string): string =>
  ["export function run(): number {", "  return 1;", "}", "", ending].join("\n");

describe("a file ending in a closing block comment", () => {
  it("accepts a trailing usage example, the exact case that was refused", () => {
    // Reproduced from the real rejected artifact: debounce.ts, 179 lines, complete.
    const source = [
      "export function debounce(fn: () => void, ms: number) {",
      "  let t: ReturnType<typeof setTimeout>;",
      "  return () => {",
      "    clearTimeout(t);",
      "    t = setTimeout(fn, ms);",
      "  };",
      "}",
      "",
      "// Example Usage:",
      "/*",
      "const f = () => console.log('hi');",
      "const d = debounce(f, 1000);",
      "d();",
      "*/",
    ].join("\n");

    expect(findTruncation("debounce.ts", source)).toBeNull();
  });

  it("accepts a trailing JSDoc block", () => {
    expect(findTruncation("util.ts", withEnding("/** trailing note */"))).toBeNull();
  });

  it("accepts a licence footer in a .js file", () => {
    expect(findTruncation("index.js", withEnding("/* SPDX-License-Identifier: MIT */"))).toBeNull();
  });

  it("accepts a CSS file ending in a comment", () => {
    // CSS is in CODE_EXTENSIONS, and a trailing comment there is entirely ordinary.
    expect(findTruncation("theme.css", ".a { color: red; }\n/* end of theme */")).toBeNull();
  });

  it("accepts a block comment closed with extra stars", () => {
    expect(findTruncation("util.ts", withEnding("/** note **/"))).toBeNull();
  });
});

describe("genuinely truncated files are still caught", () => {
  it("still rejects a bare trailing slash", () => {
    // One character away from the legal case, and it is real evidence of a cut-off line.
    expect(findTruncation("util.ts", withEnding("const ratio = total /"))).toMatch(/mid-statement/);
  });

  it("still rejects a bare trailing star", () => {
    expect(findTruncation("util.ts", withEnding("const area = width *"))).toMatch(/mid-statement/);
  });

  it("still rejects a star that does not close a comment", () => {
    // Ends with "*x" — contains a star but is not a closing marker.
    expect(findTruncation("util.ts", withEnding("const scaled = base * ("))).toMatch(
      /mid-statement/
    );
  });

  it("rejects a truncated line that merely CONTAINS a closing marker earlier", () => {
    // The exclusion must be anchored to the end of the line, not match anywhere.
    // This line closes a comment mid-way and then breaks off at an assignment, so an
    // unanchored exclusion would wave a genuinely truncated file straight through.
    // Without this fixture that mutation changed no result.
    const ending = "const a = 1; /* note */ const b =";

    expect(findTruncation("util.ts", withEnding(ending))).toMatch(/mid-statement/);
  });

  it("still rejects other dangling operators", () => {
    for (const ending of ["const a =", "return", "items.map(x =>", "if (a &&", "const b = c +"]) {
      expect(findTruncation("util.ts", withEnding(ending))).toMatch(/mid-statement/);
    }
  });

  it("does NOT catch an unterminated block comment — a pre-existing gap, not a regression", () => {
    // Asserted as it actually behaves rather than as it ought to.
    //
    // An earlier version of this test claimed findTruncation caught this. It never has:
    // the last line is prose that matches no dangling operator, the fence count is even,
    // and stripLiteralsAndComments consumes from the unterminated marker to EOF so the
    // braces balance. Null before this change and null after — the exclusion cannot fire,
    // because a file cut off inside a comment does not end in a closing marker.
    //
    // Recorded so the gap is known rather than assumed closed. Catching it needs a
    // separate unbalanced-comment check, which is not this fix.
    const source = ["export const a = 1;", "", "/*", "this comment never closes"].join("\n");

    expect(findTruncation("util.ts", source)).toBeNull();
  });

  it("still rejects a continuation marker", () => {
    expect(findTruncation("util.ts", withEnding("... rest of the file omitted"))).not.toBeNull();
  });

  it("still rejects an empty file", () => {
    expect(findTruncation("util.ts", "   \n  ")).toMatch(/is empty/);
  });
});
