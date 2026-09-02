import { describe, it, expect } from "vitest";
import {
  fenceFor,
  fitsOutputBudget,
  editOutputTokens,
  extractFencedBlock,
  findEditTruncation,
  resolveEditTarget,
  editRefusalText,
  editNoteFor,
} from "@/lib/ai/repo-edit";
import { estimateTokens, SAFETY_MARGIN_RATIO } from "@/lib/ai/context-manager";

/**
 * The two structural failures found by probing the live chat path, and their fixes.
 *
 * FAILURE 1 — SILENT TRUNCATION. ky's source/core/Ky.ts is 40,428 chars and needs about
 * 11,551 output tokens; effectiveOutputTokens is 8,192. The edit returned 966 of 1,211
 * lines with an unclosed fence, stopping mid-statement inside a catch block, and the
 * user was told nothing.
 *
 * FAILURE 2 — FENCE COLLISION. ky's source/utils/merge.ts carries a Markdown fence in a
 * JSDoc @example. Wrapped in three backticks, the example's own fence closed the block
 * early: two blocks, example content leaking between them as prose, and neither block a
 * usable file.
 *
 * Fixtures reproduce both from their real shapes rather than from tidy synthetic ones —
 * a file with no inner backticks cannot tell a correct fence scan from a hardcoded
 * three, and a file that comfortably fits cannot tell a real size check from `true`.
 */

const BACKTICK = String.fromCharCode(96);

describe("fence delimiter selection", () => {
  it("uses three backticks for ordinary content", () => {
    expect(fenceFor("export const a = 1;")).toBe(BACKTICK.repeat(3));
  });

  it("outgrows a three-backtick fence inside a JSDoc example", () => {
    // THE merge.ts SHAPE. A file whose doc comment contains its own fenced example.
    const content = [
      "/**",
      "@example",
      BACKTICK.repeat(3),
      "import ky from 'ky';",
      BACKTICK.repeat(3),
      "*/",
      "export const a = 1;",
    ].join("\n");

    expect(fenceFor(content)).toBe(BACKTICK.repeat(4));
    expect(fenceFor(content).length).toBeGreaterThan(3);
  });

  it("clears the LONGEST run, not merely the first", () => {
    // A file containing both a 3- and a 5-backtick fence must get 6, not 4. A scan that
    // stopped at the first run would return 4 and be closed by the longer one.
    const content = [BACKTICK.repeat(3), "a", BACKTICK.repeat(5), "b"].join("\n");

    expect(fenceFor(content)).toBe(BACKTICK.repeat(6));
  });

  it("handles backticks that are not at the start of a line", () => {
    // Inline code in a comment: `const x = 1`. Still a run this must clear.
    expect(fenceFor("// see " + BACKTICK.repeat(2) + "x" + BACKTICK.repeat(2))).toBe(
      BACKTICK.repeat(3)
    );
  });

  it("never returns fewer than three", () => {
    expect(fenceFor("").length).toBeGreaterThanOrEqual(3);
    expect(fenceFor("no ticks here").length).toBe(3);
  });

  it("produces a delimiter no run inside the content can close", () => {
    // The property that actually matters, asserted directly rather than via a count.
    for (const inner of [0, 1, 3, 4, 7]) {
      const content = "a" + BACKTICK.repeat(inner) + "b";
      const fence = fenceFor(content);
      expect(content.includes(fence)).toBe(false);
    }
  });
});

describe("the size precondition", () => {
  /** Roughly the real Ky.ts: far past any plausible reply budget. */
  const huge = "export const value = 1;\n".repeat(1700);
  const small = "export const a = 1;\n";

  it("refuses a file that cannot be returned whole", () => {
    expect(editOutputTokens(huge)).toBeGreaterThan(8192);
    expect(fitsOutputBudget(huge, 8192)).toBe(false);
  });

  it("accepts a file that fits", () => {
    expect(fitsOutputBudget(small, 8192)).toBe(true);
  });

  it("uses the SAME estimator the context budget uses", () => {
    // Two estimators disagreeing is how a precondition passes and the generation then
    // truncates anyway.
    expect(editOutputTokens(huge)).toBe(estimateTokens(huge));
  });

  it("applies the existing safety margin rather than a fresh constant", () => {
    // BY CONSTRUCTION: a file sized into the margin itself. It is under the raw budget
    // and over budget-minus-margin, so it passes a naive check and fails the real one.
    const budget = 10_000;
    const margin = Math.ceil(budget * SAFETY_MARGIN_RATIO);
    let content = "const x = 1;\n";
    while (estimateTokens(content) <= budget - margin) content += "const x = 1;\n";

    expect(estimateTokens(content)).toBeGreaterThan(budget - margin);
    expect(estimateTokens(content)).toBeLessThanOrEqual(budget);
    expect(fitsOutputBudget(content, budget)).toBe(false);
  });

  it("reports the file, its size and the budget in the refusal", () => {
    const r = resolveEditTarget(
      { namedPath: "Ky.ts", reason: "" },
      [{ path: "source/core/Ky.ts", content: huge }],
      ["source/core/Ky.ts"],
      8192
    );

    expect(r.kind).toBe("too-large");
    if (r.kind !== "too-large") return;
    expect(r.path).toBe("source/core/Ky.ts");
    expect(r.chars).toBe(huge.length);
    expect(r.budget).toBe(8192);

    const text = editRefusalText(r);
    expect(text).toContain("source/core/Ky.ts");
    expect(text).toContain(huge.length.toLocaleString("en-US"));
    expect(text).toContain("8,192");
    expect(text).toMatch(/will not attempt/i);
  });

  it("reports a CLAMPED file as clamped, not as oversized", () => {
    // Ordering matters: a file we only half saw must name that cause, not a size
    // consequence measured from the half we happen to hold.
    const r = resolveEditTarget(
      { namedPath: "Ky.ts", reason: "" },
      [{ path: "source/core/Ky.ts", content: huge }],
      [],
      8192
    );

    expect(r.kind).toBe("not-whole");
  });

  it("still allows a normal file through to ready", () => {
    const r = resolveEditTarget(
      { namedPath: "retry.ts", reason: "" },
      [{ path: "src/retry.ts", content: small }],
      ["src/retry.ts"],
      8192
    );

    expect(r).toEqual({ kind: "ready", path: "src/retry.ts" });
  });
});

describe("the truncation backstop", () => {
  const complete = ["export function f() {", "  return 1;", "}"].join("\n");
  const cut = ["export function f() {", "  try {", "    return 1;"].join("\n");

  it("passes a complete file", () => {
    expect(findEditTruncation("a.ts", complete)).toBeNull();
  });

  it("catches a file that stops mid-block", () => {
    // The real shape: Ky.ts stopped inside a catch with braces still open.
    expect(findEditTruncation("a.ts", cut)).toMatch(/unclosed brace/);
  });

  it("extracts the block from a reply with a closed fence", () => {
    const reply = ["Here you go:", BACKTICK.repeat(3) + "ts", complete, BACKTICK.repeat(3)].join(
      "\n"
    );

    expect(extractFencedBlock(reply)).toBe(complete);
  });

  it("extracts what there is from a reply whose fence never closed", () => {
    // THE Ky.ts CASE. An unclosed fence is exactly the reply that needs checking, so
    // returning null here would disable the backstop precisely when it is needed.
    const reply = ["Here you go:", BACKTICK.repeat(3) + "ts", cut].join("\n");
    const block = extractFencedBlock(reply);

    expect(block).toBe(cut);
    expect(findEditTruncation("a.ts", block!)).toMatch(/unclosed brace/);
  });

  it("returns null when the reply has no fence at all", () => {
    expect(extractFencedBlock("just prose, no code")).toBeNull();
  });

  it("spans from the first fence to the last on a split reply", () => {
    // The merge.ts shape: two blocks with prose between. Treating the whole span as the
    // file is what lets the check see the real end of the output.
    const reply = [
      BACKTICK.repeat(3),
      "part one",
      BACKTICK.repeat(3),
      "leaked prose",
      BACKTICK.repeat(3),
      "part two",
      BACKTICK.repeat(3),
    ].join("\n");

    expect(extractFencedBlock(reply)).toContain("part one");
    expect(extractFencedBlock(reply)).toContain("part two");
  });
});

describe("the note sent to the model", () => {
  it("names the exact delimiter for a file containing its own fence", () => {
    const content = [BACKTICK.repeat(3), "example", BACKTICK.repeat(3), "export const a = 1;"].join(
      "\n"
    );
    const note = editNoteFor("src/utils/merge.ts", content);

    expect(note).toContain(BACKTICK.repeat(4));
    expect(note).toContain("4 backticks");
    expect(note).toMatch(/ONE fenced/);
  });

  it("asks for three backticks on an ordinary file", () => {
    const note = editNoteFor("src/retry.ts", "export const a = 1;");

    expect(note).toContain("3 backticks");
  });
});
