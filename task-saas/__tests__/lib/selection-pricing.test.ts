import { describe, it, expect } from "vitest";
import { selectWithinBudget, type ScoredFile } from "@/lib/repo/selection";

/**
 * Pricing a candidate file from its stored size.
 *
 * THE ACCIDENT THIS PINS DOWN. Pricing used to run the content-aware estimator over
 * `"x".repeat(file.size)` — a placeholder standing in for bytes nobody had fetched.
 * That string contains no punctuation, so it classified as PROSE, the most generous
 * bucket. What rescued it was an unrelated rule: the estimator clamps to 3.0 when it
 * sees an alphanumeric run longer than 60 characters, a guard written for base64 and
 * minified bundles.
 *
 * So every file over 60 bytes was priced correctly by a heuristic aimed at something
 * else, and every file UNDER 60 bytes escaped the clamp and was priced as prose. The
 * 60-byte boundary below is the fixture that shows it: it exists nowhere in this
 * module's logic and had no business affecting file ranking.
 *
 * Numbers here are LITERAL, never derived from SOURCE_CHARS_PER_TOKEN — a fixture
 * computed from the constant under test moves with a mutation and proves nothing.
 */

const file = (path: string, size: number): ScoredFile =>
  ({ path, size, language: "typescript", symbols: [], internalSymbols: [], score: 1 }) as ScoredFile;

describe("pricing from size", () => {
  it("charges a file 1 token per 3 bytes", () => {
    // 3,000 bytes -> 1,000 tokens. An allowance of exactly 1,000 admits it; one less
    // does not. Both literal.
    expect(selectWithinBudget([file("a.ts", 3000)], 1000, 5)).toHaveLength(1);
    expect(selectWithinBudget([file("a.ts", 3000)], 999, 5)).toHaveLength(0);
  });

  it("prices the SAME as before this change for a file over 60 bytes", () => {
    // Behaviour preservation, stated as a number rather than as a claim. 30,000 bytes
    // cost 10,000 tokens under the old accidental 3.0 divisor and must still.
    expect(selectWithinBudget([file("big.ts", 30_000)], 10_000, 5)).toHaveLength(1);
    expect(selectWithinBudget([file("big.ts", 30_000)], 9_999, 5)).toHaveLength(0);
  });

  it("prices a file UNDER 60 bytes on the same rule as every other file", () => {
    /**
     * THE BOUNDARY THE OLD CODE GOT WRONG. A 45-byte file escaped the base64 clamp and
     * was priced as prose — 9 tokens at the old 5.0 divisor, 12 at the 4.0 before it.
     * It now costs 15, the same 3 bytes per token as a large file.
     *
     * An allowance of 14 must refuse it. Under the old pricing 14 was comfortably
     * enough, so this fixture fails against the previous behaviour by construction.
     */
    expect(selectWithinBudget([file("tiny.ts", 45)], 15, 5)).toHaveLength(1);
    expect(selectWithinBudget([file("tiny.ts", 45)], 14, 5)).toHaveLength(0);
  });

  it("never prices a file at zero", () => {
    // A free file always "fits", so an empty or unreadable row would be selected ahead
    // of real candidates.
    expect(selectWithinBudget([file("empty.ts", 0)], 0, 5)).toHaveLength(0);
    expect(selectWithinBudget([file("empty.ts", 0)], 1, 5)).toHaveLength(1);
  });

  it("stops at the allowance rather than part-selecting a file", () => {
    // 3,000 bytes each = 1,000 tokens each. Two fit in 2,000, the third does not.
    const files = [file("a.ts", 3000), file("b.ts", 3000), file("c.ts", 3000)];

    expect(selectWithinBudget(files, 2000, 5).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("skips an oversized file but keeps taking smaller ones behind it", () => {
    // The loop continues rather than breaking, so one huge file does not starve the
    // rest of the ranking.
    const files = [file("huge.ts", 300_000), file("small.ts", 300)];

    expect(selectWithinBudget(files, 1000, 5).map((f) => f.path)).toEqual(["small.ts"]);
  });

  it("respects the file-count cap independently of the budget", () => {
    const files = [file("a.ts", 30), file("b.ts", 30), file("c.ts", 30)];

    expect(selectWithinBudget(files, 1_000_000, 2)).toHaveLength(2);
  });
});
