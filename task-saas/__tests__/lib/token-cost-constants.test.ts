import { describe, it, expect } from "vitest";
import {
  CHARS_PER_TOKEN,
  ENCODED_RUN_THRESHOLD,
  SIZE_ONLY_PESSIMISM,
  estimateTokens,
  estimateTokensFromBytes,
} from "@/lib/ai/context-manager";
import { selectWithinBudget, type ScoredFile } from "@/lib/repo/selection";

/**
 * The canonical token-cost ratios, and the two things that must not drift.
 *
 * WHY THIS FILE EXISTS. selection.ts carried its own 3.0 while context-manager carried
 * 3.2 — the same physical quantity, chars per token for source on this model, in two
 * modules. They had already drifted once: selection's number was not chosen at all, it
 * fell out of the encoded-content clamp firing on a synthetic placeholder. A
 * calibration touching one and not the other moved file ranking silently.
 *
 * Byte pricing is now DERIVED from the source ratio, so the two cannot separate. The
 * cross-module test at the bottom is the one that proves it.
 *
 * Every expected value here is a LITERAL. Numbers derived from the constant under test
 * move with a mutation and prove nothing — that trap survived two mutation rounds
 * earlier in this work.
 */

const file = (path: string, size: number): ScoredFile =>
  ({ path, size, language: "typescript", symbols: [], internalSymbols: [], score: 1 }) as ScoredFile;

describe("the canonical ratios", () => {
  it("holds the calibrated values", () => {
    expect(CHARS_PER_TOKEN.dense).toBe(2.5);
    expect(CHARS_PER_TOKEN.source).toBe(3.2);
    expect(CHARS_PER_TOKEN.commented).toBe(3.5);
    expect(CHARS_PER_TOKEN.prose).toBe(5.0);
    expect(CHARS_PER_TOKEN.encoded).toBe(3.0);
  });

  it("orders them from densest to sparsest", () => {
    // Denser content must never be charged less per character than sparser content, or
    // the buckets are describing something other than token density.
    expect(CHARS_PER_TOKEN.dense).toBeLessThan(CHARS_PER_TOKEN.source);
    expect(CHARS_PER_TOKEN.source).toBeLessThan(CHARS_PER_TOKEN.commented);
    expect(CHARS_PER_TOKEN.commented).toBeLessThan(CHARS_PER_TOKEN.prose);
  });

  it("keeps byte pricing at or below content pricing", () => {
    /**
     * THE PESSIMISM INVARIANT. A file priced from size alone must never be charged LESS
     * per byte than the same content would be, because under-charging spends a GitHub
     * request on a file the packer then drops.
     */
    expect(CHARS_PER_TOKEN.source * SIZE_ONLY_PESSIMISM).toBeLessThanOrEqual(
      CHARS_PER_TOKEN.source
    );
    expect(SIZE_ONLY_PESSIMISM).toBeLessThanOrEqual(1);
  });

  it("derives byte pricing to exactly 3.0 chars per token", () => {
    // Literal, and it is the number selection.ts used before the consolidation — the
    // proof that ranking did not move.
    expect(CHARS_PER_TOKEN.source * SIZE_ONLY_PESSIMISM).toBe(3.0);
  });
});

describe("the encoded-content threshold", () => {
  it("is 60 unbroken alphanumeric characters", () => {
    expect(ENCODED_RUN_THRESHOLD).toBe(60);
  });

  it("does not fire at 60, and does fire at 61", () => {
    /**
     * THE BOUNDARY, pinned so tuning the clamp cannot silently reprice files again.
     *
     * Both fixtures are prose by punctuation (a bare run of letters), so the bucket
     * would be 5.0 and only the clamp can pull them to 3.0. 60 characters is 12 tokens
     * at 5.0; 61 is 21 at 3.0. The two are far enough apart that no rounding hides the
     * difference.
     */
    const at60 = "a".repeat(60);
    const at61 = "a".repeat(61);

    expect(estimateTokens(at60)).toBe(12);
    expect(estimateTokens(at61)).toBe(21);
  });

  it("leaves ordinary source alone", () => {
    /**
     * AUDITED 2026-09-02: the clamp fired on 0 of 62 indexed source files across both
     * repositories, and the longest run in ky's package.json, readme, license and
     * tsconfig was 26. The nearest realistic shape is a long camelCase identifier at 50.
     */
    const longIdentifier = "const aVeryLongDescriptiveIdentifierNameForConfiguration = 1;";

    // Asserted WITHOUT naming a bucket: which bucket ordinary source lands in is the
    // estimator's business, and pinning it here would make this test fail on an
    // unrelated recalibration. What matters is only that the clamp did NOT fire —
    // clamping to 3.0 would price this line strictly higher than any other bucket does.
    expect(estimateTokens(longIdentifier)).toBeLessThan(
      Math.ceil(longIdentifier.length / CHARS_PER_TOKEN.encoded)
    );
  });

  it("fires on a hash and a base64 blob", () => {
    // What it is actually for. Both are pure alphanumeric runs well past 60.
    const hash = "a".repeat(64);
    const base64 = "aGVsbG8gd29ybGQgdGhpc2lzYmFzZTY0Y29udGVudA".repeat(4);

    expect(estimateTokens(hash)).toBe(Math.ceil(64 / 3.0));
    expect(estimateTokens(base64)).toBe(Math.ceil(base64.length / 3.0));
  });
});

describe("byte pricing", () => {
  it("charges one token per three bytes", () => {
    expect(estimateTokensFromBytes(3000)).toBe(1000);
    expect(estimateTokensFromBytes(30_000)).toBe(10_000);
    expect(estimateTokensFromBytes(45)).toBe(15);
  });

  it("never returns zero", () => {
    expect(estimateTokensFromBytes(0)).toBe(1);
    expect(estimateTokensFromBytes(-5)).toBe(1);
  });
});

describe("the constant reaches BOTH modules", () => {
  /**
   * THE POINT OF THE CONSOLIDATION. Changing CHARS_PER_TOKEN.source must move content
   * pricing AND file ranking together. These two assertions read the same constant
   * through two different modules, so a mutation of it fails in both places rather than
   * leaving one silently stale.
   */
  it("prices content through context-manager at the source ratio", () => {
    // A file blended to land in the source bucket (0.12-0.2 punctuation).
    const dense = "const {a, b} = opts; if (a?.x && b?.y) { return [a.x, b.y]; }\n";
    const comment = "// Merge the incoming options with the defaults before sending it on\n";
    const content = (dense.repeat(3) + comment.repeat(3)).repeat(14);

    expect(content.length / estimateTokens(content)).toBeCloseTo(3.2, 1);
  });

  it("prices bytes through selection at the derived ratio", () => {
    // 3,000 bytes -> 1,000 tokens. Literal on both sides.
    expect(selectWithinBudget([file("a.ts", 3000)], 1000, 5)).toHaveLength(1);
    expect(selectWithinBudget([file("a.ts", 3000)], 999, 5)).toHaveLength(0);
  });
});
