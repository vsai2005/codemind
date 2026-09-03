import { describe, it, expect, vi } from "vitest";
import { scanImports, supportsImports } from "@/lib/repo/imports";
import { verifyArtifact } from "@/lib/artifacts/verify";
import type { NormalizedArtifact } from "@/lib/artifacts/types";

/**
 * Scan confidence, and each caller's response to it.
 *
 * THE FAIL-OPEN PATH THIS CLOSES
 * extractImports caught its own failures and returned whatever it had found so far. A
 * partial list was indistinguishable from a complete one, which is harmless on the
 * ingestion path — fewer edges — and dangerous on the verification path, where fewer
 * specifiers means fewer unresolved-import errors. An artifact could therefore pass
 * because its imports were NOT READ rather than because they resolved.
 *
 * FIXTURES ARE NAMED ADVERSARIALLY. Three false-negative tests slipped through on each
 * of the last two changes because a fixture let the right answer emerge by luck. Here
 * the unresolved import is placed LAST, past the scan cap, so a test that passed
 * without the confidence flag could only be passing by accident.
 */

const project = (files: Record<string, string>): NormalizedArtifact => ({
  type: "zip",
  filename: "project.zip",
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  nameSource: "model",
});

const codes = (findings: Array<{ code: string }>): string[] => findings.map((f) => f.code);

/** 200 imports is the per-file cap, so 201 statements guarantee truncation. */
function oversizedImportFile(tailSpecifier: string): string {
  const lines = Array.from(
    { length: 205 },
    (_, i) => `import { thing${i} } from "./generated/mod${i}";`
  );
  // The broken import goes LAST, in the part a truncated scan never reaches. This is
  // the whole construction: before the change it was invisible.
  lines.push(`import { missing } from "${tailSpecifier}";`);
  return lines.join("\n");
}

describe("scanImports reports its own confidence", () => {
  it("reports complete for a file with genuinely zero imports", () => {
    // Not "incomplete because nothing was found". A file can honestly import nothing,
    // and conflating that with a failed scan is the confusion this type removes.
    const scan = scanImports("export const value = 1;\n");

    expect(scan.specifiers).toEqual([]);
    expect(scan.status).toBe("complete");
    expect(scan.unread).toBe(0);
  });

  it("reports complete for an ordinary file", () => {
    const scan = scanImports(`import a from "./a";\nexport const b = a;`);

    expect(scan.specifiers).toEqual(["./a"]);
    expect(scan.status).toBe("complete");
  });

  it("reports truncated, and still returns what it found", () => {
    const scan = scanImports(oversizedImportFile("./never-generated"));

    expect(scan.status).toBe("truncated");
    // Partial results are KEPT: discarding them would trade a known-incomplete list for
    // an emptier one, which is worse on both counts.
    expect(scan.specifiers.length).toBeGreaterThan(100);
    // And the tail really was never reached — this is what made the old behaviour unsafe.
    expect(scan.specifiers).not.toContain("./never-generated");
  });

  it("counts import targets built at runtime, which no regex can follow", () => {
    const scan = scanImports(
      [
        `const a = require(base + "/mod");`,
        `const b = await import(nameFromConfig);`,
        `import c from "./real";`,
      ].join("\n")
    );

    expect(scan.unread).toBe(2);
    expect(scan.specifiers).toEqual(["./real"]);
    // A computed target is not a scan failure: the file was read end to end.
    expect(scan.status).toBe("complete");
  });

  it("does not count a normal require as unreadable", () => {
    expect(scanImports(`const x = require("./mod");`).unread).toBe(0);
  });

  it("keeps language support separate from scan status", () => {
    // Two dimensions, not one boolean. supportsImports is a precondition the CALLER
    // checks; status describes what happened once scanning started.
    expect(supportsImports("python")).toBe(false);
    expect(scanImports("import os").status).toBe("complete");
  });
});

describe("verification response to scan confidence", () => {
  const CLEAN = {
    "package.json": JSON.stringify({ name: "demo", dependencies: {} }),
    "src/index.ts": `import { helper } from "./helper";\nexport const app = helper;`,
    "src/helper.ts": `export const helper = 1;`,
  };

  it("no longer passes an artifact that passed only because a file was not fully scanned", () => {
    // THE POINT OF THE CHANGE, constructed deliberately.
    //
    // Every one of the 205 generated imports resolves, and the 206th — the broken one —
    // sits past the scan cap. Before this change the checker read 200 specifiers, found
    // them all resolvable, and reported the project clean. The unresolved import was
    // never seen, so its absence from the report meant nothing at all.
    const generated: Record<string, string> = { ...CLEAN };
    for (let i = 0; i < 205; i++) {
      generated[`src/generated/mod${i}.ts`] = `export const thing${i} = ${i};`;
    }
    generated["src/index.ts"] = oversizedImportFile("./never-generated");

    const report = verifyArtifact(project(generated));

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("imports-unreadable");
    expect(report.errors.find((e) => e.code === "imports-unreadable")!.file).toBe("src/index.ts");
  });

  it("still fails an artifact with a real unresolved import, as before", () => {
    const report = verifyArtifact(
      project({ ...CLEAN, "src/index.ts": `import { db } from "./lib/db";\nexport const a = db;` })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("unresolved-internal-import");
  });

  it("does not block an artifact whose language the scanner cannot read", () => {
    // UNSUPPORTED LANGUAGE IS NOT A FAILED SCAN. Blocking here would refuse every valid
    // project outside JavaScript and TypeScript — the two states must not collapse.
    const report = verifyArtifact(
      project({
        "requirements.txt": "flask==3.0.0",
        "app.py": "import flask\nfrom .missing import thing\n",
        "util.py": "def helper():\n    return 1\n",
      })
    );

    expect(report.ok).toBe(true);
    expect(codes(report.errors)).not.toContain("imports-unreadable");
    // And it says the check did not run, rather than that it passed.
    expect(report.checks.find((c) => c.check === "imports-resolve")!.status).toBe("skipped");
  });

  it("warns rather than blocks when an import target is built at runtime", () => {
    // Legal, common, and unreadable. Blocking would refuse valid projects for using a
    // language feature correctly; the warning names the file a human should look at.
    const report = verifyArtifact(
      project({
        ...CLEAN,
        "src/index.ts": `import { helper } from "./helper";\nconst m = require(base + "/x");\nexport const app = [helper, m];`,
      })
    );

    expect(report.ok).toBe(true);
    expect(codes(report.warnings)).toContain("dynamic-import-target");
    expect(report.warnings.find((w) => w.code === "dynamic-import-target")!.file).toBe(
      "src/index.ts"
    );
  });

  it("still passes a clean project, so the rule is not simply rejecting everything", () => {
    const report = verifyArtifact(project(CLEAN));

    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.check === "imports-resolve")!.status).toBe("passed");
  });
});

describe("verification response to an aborted scan", () => {
  it("blocks a file whose scan aborted", async () => {
    /**
     * `aborted` cannot currently be produced by any input: the patterns in imports.ts
     * are simple enough that none of them throws. It is a defensive state, so the only
     * honest way to test verification's response to it is to inject one — mocking here
     * tests the RESPONSE, and the note above is why no fixture can.
     */
    vi.resetModules();
    vi.doMock("@/lib/repo/imports", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        scanImports: () => ({ specifiers: [], status: "aborted" as const, unread: 0 }),
      };
    });

    const { verifyArtifact: verifyWithAbort } = await import("@/lib/artifacts/verify");
    const report = verifyWithAbort(
      project({
        "package.json": JSON.stringify({ name: "demo" }),
        "src/index.ts": `export const a = 1;`,
      })
    );

    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain("imports-unreadable");
    expect(report.errors[0].detail?.status).toBe("aborted");

    vi.doUnmock("@/lib/repo/imports");
    vi.resetModules();
  });
});
