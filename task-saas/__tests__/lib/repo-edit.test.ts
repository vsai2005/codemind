import { describe, it, expect } from "vitest";
import { detectArtifactIntent, detectEditIntent } from "@/lib/ai/intent";
import { resolveEditTarget, editNoteFor, editRefusalText } from "@/lib/ai/repo-edit";
import { ContextManager } from "@/lib/ai/context-manager";

/** Generous enough that no fixture below trips the size precondition by accident. */
const BUDGET = 8192;

/**
 * Slice one of repository editing: propose an edit inline, refuse when the file was not
 * seen whole.
 *
 * THE LOAD-BEARING BEHAVIOUR IS THE REFUSAL, not the edit. A model handed half a file
 * rewrites it with complete confidence and returns something plausible, wrong and
 * silently incomplete — there is nothing in the output that says "I only saw the first
 * 400 lines". Every other test here protects a convenience; the clamp tests protect
 * against shipping wrong code to a user who cannot tell.
 *
 * FIXTURES ARE BUILT SO THE CLAMP ACTUALLY FIRES. A fixture whose file comfortably fits
 * returns "ready" whether the clamp signal is honest or hardcoded to true, and proves
 * nothing — the same shape of mistake that let an ASCII-only fixture hide a real bug
 * earlier. The oversized fixtures below exceed the repository allowance BY
 * CONSTRUCTION, computed from the budget rather than guessed at.
 */

describe("edit intent", () => {
  it("detects a change request naming a file", () => {
    const intent = detectEditIntent("fix the retry backoff in src/retry.ts");

    expect(intent).not.toBeNull();
    // The BASENAME, not the path the user typed. FILENAME_REF captures a filename
    // rather than a path, and resolveEditTarget matches on a path suffix — so
    // "retry.ts" finds "src/retry.ts" whether or not the user typed the directory.
    // Asserting the full path here would pin behaviour the resolver does not need.
    expect(intent!.namedPath).toBe("retry.ts");
  });

  it("detects a change request describing its target", () => {
    // How people name a file whose path they cannot remember.
    const intent = detectEditIntent("can you fix the retry logic");

    expect(intent).not.toBeNull();
    expect(intent!.namedPath).toBeNull();
  });

  it("ignores an explanation request", () => {
    // The regression that would matter most: turning "how does X work" into a rewrite.
    expect(detectEditIntent("how does the retry logic work")).toBeNull();
    expect(detectEditIntent("explain how auth.ts handles expiry")).toBeNull();
    expect(detectEditIntent("what does src/retry.ts do")).toBeNull();
  });

  it("ignores a verb with nothing to aim at", () => {
    // "fix it" needs conversation state this classifier cannot see, and guessing a
    // file to rewrite is the failure the whole slice exists to prevent.
    expect(detectEditIntent("fix it")).toBeNull();
    expect(detectEditIntent("can you clean this up")).toBeNull();
  });

  it("ignores an empty or non-string message", () => {
    expect(detectEditIntent("")).toBeNull();
    expect(detectEditIntent(null)).toBeNull();
    expect(detectEditIntent(42)).toBeNull();
  });
});

describe("artifact requests are unaffected", () => {
  /**
   * THE DISAMBIGUATION RULE, asserted rather than described. "download the fixed
   * auth.ts" is already an artifact request, and the route consults edit intent only
   * where the artifact router declined — so these messages never reach the edit path
   * at all, and slice one changes nothing about them.
   */
  it("still routes a delivery request to the artifact pipeline", () => {
    for (const text of [
      "give me the fixed auth.ts",
      "download the updated retry.ts",
      "i want the files as a zip",
    ]) {
      expect(detectArtifactIntent(text)).not.toBeNull();
    }
  });

  it("leaves a generation request classified as an artifact, not an edit", () => {
    const text = "give me a debounce function as a file";

    expect(detectArtifactIntent(text)).not.toBeNull();
  });
});

describe("resolving a loosely-named target", () => {
  const fetched = [
    { path: "src/routes/auth.ts", content: "export const a = 1;" },
    { path: "src/retry.ts", content: "export const a = 1;" },
  ];

  it("matches a bare filename to its full path", () => {
    const r = resolveEditTarget({ namedPath: "auth.ts", reason: "" }, fetched, [
      "src/routes/auth.ts",
    ], BUDGET);

    expect(r).toEqual({ kind: "ready", path: "src/routes/auth.ts" });
  });

  it("does not match a filename that is only a suffix of another name", () => {
    // "auth.ts" must not resolve to "oauth.ts" — the match is anchored on a path
    // segment, so a user asking about one file cannot be given the other.
    const r = resolveEditTarget({ namedPath: "auth.ts", reason: "" }, [{ path: "src/oauth.ts", content: "export const a = 1;" }], [
      "src/oauth.ts",
    ], BUDGET);

    expect(r.kind).toBe("not-found");
  });

  it("asks which file when a described target has several candidates", () => {
    // Silently picking the highest-ranked one would rewrite a file the user did not
    // mean, and the reply would look identical either way.
    const r = resolveEditTarget({ namedPath: null, reason: "" }, fetched, [
      "src/routes/auth.ts",
      "src/retry.ts",
    ], BUDGET);

    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("accepts a described target when only one file was fetched", () => {
    const r = resolveEditTarget({ namedPath: null, reason: "" }, [{ path: "src/retry.ts", content: "export const a = 1;" }], [
      "src/retry.ts",
    ], BUDGET);

    expect(r).toEqual({ kind: "ready", path: "src/retry.ts" });
  });

  it("reports an honest failure for a file that was not fetched", () => {
    const r = resolveEditTarget({ namedPath: "missing.ts", reason: "" }, fetched, [
      "src/retry.ts",
    ], BUDGET);

    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") expect(r.available).toEqual(fetched.map((f) => f.path));
  });

  it("reports no-files when the repository could not be read", () => {
    expect(resolveEditTarget({ namedPath: "a.ts", reason: "" }, [], [], BUDGET).kind).toBe("no-files");
  });

  it("REFUSES when the file was fetched but not seen whole", () => {
    // THE TEST THAT MATTERS. The file is present in `fetched` — selection chose it, it
    // was downloaded, the path is right — and absent from the whole list because the
    // budget clamped it. Everything looks ready except the one fact that decides it.
    const r = resolveEditTarget({ namedPath: "retry.ts", reason: "" }, fetched, [
      "src/routes/auth.ts",
    ], BUDGET);

    expect(r).toEqual({ kind: "not-whole", path: "src/retry.ts" });
  });
});

describe("the refusals themselves", () => {
  it("never hedges a partial view into a warning", () => {
    // A refusal that reads as a caveat gets ignored, and the user applies the code
    // anyway. It has to say plainly that no edit was attempted.
    const text = editRefusalText({ kind: "not-whole", path: "src/big.ts" });

    expect(text).toContain("src/big.ts");
    expect(text).toMatch(/will not edit/i);
    expect(text).toMatch(/only saw part|partial/i);
  });

  it("names what it did read when the target is missing", () => {
    const text = editRefusalText({
      kind: "not-found",
      named: "missing.ts",
      available: ["src/a.ts", "src/b.ts"],
    });

    expect(text).toContain("missing.ts");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");
  });

  it("asks the user to choose rather than choosing", () => {
    const text = editRefusalText({ kind: "ambiguous", candidates: ["a.ts", "b.ts"] });

    expect(text).toMatch(/which/i);
    expect(text).toMatch(/will not guess/i);
  });

  it("asks for the whole file back when the file is present in full", () => {
    const note = editNoteFor("src/retry.ts", "export const a = 1;");

    expect(note).toContain("src/retry.ts");
    expect(note).toMatch(/IN FULL/);
    expect(note).toMatch(/COMPLETE modified file/);
    expect(note).toMatch(/not a diff/i);
  });
});

describe("the clamp signal from ContextManager", () => {
  const base = { id: "u1", role: "user" as const, content: "fix the retry logic" };

  const build = (files: Array<{ path: string; content: string }>, contextTokens: number) =>
    ContextManager.buildContext([], base, null, { repositoryFiles: files, contextTokens });

  it("reports a small file as whole", () => {
    const result = build([{ path: "src/retry.ts", content: "export const a = 1;\n" }], 100_000);

    expect(result.repositoryFilesWhole).toEqual(["src/retry.ts"]);
  });

  it("does NOT report a clamped file as whole", () => {
    /**
     * BY CONSTRUCTION. The window is 4,000 tokens, of which repository files get 35%
     * — about 1,400. The file below is ~40,000 characters, which no divisor in
     * estimateTokens brings under that. It is the FIRST and only file, which is
     * precisely the case the clamp branch handles, so it IS rendered — clamped — and
     * must still be absent from the whole list.
     */
    const huge = "export const x = 1;\n".repeat(2000);
    const result = build([{ path: "src/huge.ts", content: huge }], 20_000);

    expect(result.contextBlocks).toContain("src/huge.ts");
    expect(result.repositoryFilesWhole).not.toContain("src/huge.ts");
    expect(result.repositoryFilesWhole).toEqual([]);
  });

  it("does not report an omitted file as whole", () => {
    // A second file that does not fit is dropped entirely rather than clamped. Absent
    // for a different reason, and absence has to mean the same thing to the caller.
    const small = "export const a = 1;\n";
    const huge = "export const x = 1;\n".repeat(2000);
    const result = build(
      [
        { path: "src/small.ts", content: small },
        { path: "src/huge.ts", content: huge },
      ],
      20_000
    );

    expect(result.repositoryFilesWhole).toContain("src/small.ts");
    expect(result.repositoryFilesWhole).not.toContain("src/huge.ts");
  });

  it("is empty when no repository files were supplied", () => {
    const result = ContextManager.buildContext([], base, null, { contextTokens: 100_000 });

    expect(result.repositoryFilesWhole).toEqual([]);
  });

  it("feeds the refusal end to end for a clamped file", () => {
    // The two halves joined: the clamp signal from ContextManager drives the refusal
    // in repo-edit, which is how the route wires them.
    const huge = "export const x = 1;\n".repeat(2000);
    const result = build([{ path: "src/huge.ts", content: huge }], 20_000);
    const resolution = resolveEditTarget(
      { namedPath: "huge.ts", reason: "" },
      [{ path: "src/huge.ts", content: "export const a = 1;" }],
      result.repositoryFilesWhole,
      BUDGET
    );

    expect(resolution.kind).toBe("not-whole");
    expect(editRefusalText(resolution)).toMatch(/will not edit/i);
  });
});
