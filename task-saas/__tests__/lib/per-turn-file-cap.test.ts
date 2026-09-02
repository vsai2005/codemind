import { describe, it, expect } from "vitest";
import {
  MAX_REPOSITORY_FILES_PER_TURN,
  selectWithinBudget,
  type ScoredFile,
} from "@/lib/repo/selection";

/**
 * The per-turn repository file cap.
 *
 * WHY IT MOVED. Measured on three real questions against ky with actual provider usage:
 * three files consumed 1.6-8.9% of a 512,000-token window, and fifty-four candidates
 * were being narrowed to three every time. The token budget was never the binding
 * constraint — this number was.
 *
 * WHY IT IS PINNED. Each file is one serial GitHub request at roughly 400-500ms, so the
 * cap is simultaneously an answer-quality dial and a latency budget. Moving it silently
 * changes both, and it is the kind of constant that gets "temporarily" nudged.
 *
 * Fixtures are sized from LITERAL token counts. A fixture derived from the cap moves
 * with a mutation of the cap and proves nothing.
 */

const file = (path: string, size: number): ScoredFile =>
  ({ path, size, language: "typescript", symbols: [], internalSymbols: [], score: 1 }) as ScoredFile;

/** Twelve candidates, each 300 bytes = 100 tokens. Both numbers literal. */
const candidates = Array.from({ length: 12 }, (_, i) => file(`src/f${i}.ts`, 300));

describe("the per-turn file cap", () => {
  it("is ten", () => {
    // The literal that makes a change to this constant a decision rather than a
    // side effect. Raised from 3 on 2026-09-03; see the constant for the measurements.
    expect(MAX_REPOSITORY_FILES_PER_TURN).toBe(10);
  });

  it("selects ten of twelve candidates when the budget is not binding", () => {
    // 12 candidates x 100 tokens = 1,200; allowance 100,000 cannot bind. So whatever
    // limits the result IS the cap. Reverting it to 3 fails here.
    const chosen = selectWithinBudget(candidates, 100_000, MAX_REPOSITORY_FILES_PER_TURN);

    expect(chosen).toHaveLength(10);
  });

  it("is more than the three it replaced", () => {
    // Stated as an inequality against a literal, so a revert to 3 — or to anything
    // below it — fails regardless of what the cap becomes next.
    expect(MAX_REPOSITORY_FILES_PER_TURN).toBeGreaterThan(3);
  });

  it("stays a real cap rather than being removed", () => {
    /**
     * An uncapped selection would take all twelve, and at ~450ms per serial GitHub
     * request that is a turn spending five seconds fetching. The cap is a latency
     * budget as much as a context one.
     */
    expect(MAX_REPOSITORY_FILES_PER_TURN).toBeLessThan(12);
    expect(selectWithinBudget(candidates, 100_000, MAX_REPOSITORY_FILES_PER_TURN).length).toBeLessThan(
      candidates.length
    );
  });

  it("is never zero, which would silently disable repository context", () => {
    /**
     * A cap of 0 selects nothing, and the failure is invisible: the model answers from
     * the conversation alone and sounds exactly as confident as it would with the
     * files. loadRepositoryFiles logs an empty selection, but the reply does not say so.
     */
    expect(MAX_REPOSITORY_FILES_PER_TURN).toBeGreaterThan(0);
    expect(selectWithinBudget(candidates, 100_000, MAX_REPOSITORY_FILES_PER_TURN).length).toBeGreaterThan(0);
  });

  it("still yields to the token budget when that binds first", () => {
    // The cap raises the ceiling; it does not override pricing. 300 bytes = 100 tokens
    // each, so an allowance of 450 admits four regardless of a cap of ten.
    expect(selectWithinBudget(candidates, 450, MAX_REPOSITORY_FILES_PER_TURN)).toHaveLength(4);
  });
});
