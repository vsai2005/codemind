import { describe, it, expect } from "vitest";
import { verifyArtifact, attemptFromReport } from "@/lib/artifacts/verify";
import type { NormalizedArtifact } from "@/lib/artifacts/types";

/**
 * Coverage on the verification report.
 *
 * WHAT THIS DISTINGUISHES, AND WHY IT NEEDED TO
 * `ok` is `errors.length === 0`, which reads identically whether every check passed or
 * every check was SKIPPED. Measured on the first ten persisted artifacts: three passed
 * with zero checks run. Nothing downstream could tell those from a fully checked
 * project, so "verified" meant "nobody objected", which included "nobody looked".
 *
 * FIXTURES ARE NAMED ADVERSARIALLY. Three false-negative tests slipped through earlier
 * in this session on fixtures that were right by luck, so each case below is built so
 * that the WRONG computation produces a different answer, not the same one:
 *   - the partial case has an UNEQUAL split (2 ran, 2 skipped), so a computation that
 *     compared the wrong operands cannot land on "partial" by coincidence;
 *   - the checked case carries a warning, so "no findings" cannot stand in for
 *     "everything ran";
 *   - the failing case is a single failed check among passes, so "failed" cannot be
 *     mistaken for "skipped".
 */

const project = (files: Record<string, string>): NormalizedArtifact => ({
  type: "zip",
  filename: "project.zip",
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
});

const ran = (r: ReturnType<typeof verifyArtifact>): number =>
  r.checks.filter((c) => c.status !== "skipped").length;
const skipped = (r: ReturnType<typeof verifyArtifact>): number =>
  r.checks.filter((c) => c.status === "skipped").length;

describe("verification coverage", () => {
  it("reports checked when every check ran, warnings and all", () => {
    // A warning is present on purpose: coverage describes what RAN, not what was found,
    // so a clean-but-warned project must still be "checked".
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({
          name: "demo",
          dependencies: { react: "^18.0.0" },
          devDependencies: { eslint: "^9.0.0" },
        }),
        "src/index.ts": `import React from "react";\nimport { helper } from "./helper";\nexport const app = () => helper(React);`,
        "src/helper.ts": `export const helper = (x: unknown) => x;`,
      })
    );

    expect(report.ok).toBe(true);
    expect(report.coverage).toBe("checked");
    expect(ran(report)).toBe(4);
    expect(skipped(report)).toBe(0);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it("reports partial on an UNEQUAL split of ran and skipped", () => {
    // A Python project: imports and manifest skip (language not parsed, no package.json),
    // required-files and structural-sanity run. 2 and 2 would be a suspicious fixture —
    // this asserts the actual counts so the split is visible rather than assumed.
    const report = verifyArtifact(
      project({
        "main.py": "import os\n\n\ndef run():\n    return os.getcwd()\n",
        "util.py": "def helper():\n    return 1\n",
        "README.md": "# demo",
      })
    );

    expect(report.ok).toBe(true);
    expect(report.coverage).toBe("partial");
    expect(ran(report)).toBe(2);
    expect(skipped(report)).toBe(2);
  });

  it("reports unchecked when nothing ran, and ok is STILL true", () => {
    // The case that made this necessary. A single-file artifact skips all four checks
    // legitimately, and must keep passing — refusing it would be a regression.
    const report = verifyArtifact({
      type: "file",
      filename: "debounce.ts",
      files: [{ path: "debounce.ts", content: "export const debounce = () => {};" }],
    });

    expect(report.ok).toBe(true);
    expect(report.coverage).toBe("unchecked");
    expect(ran(report)).toBe(0);
    expect(skipped(report)).toBe(4);
  });

  it("reports unchecked for a pdf, which has no files at all", () => {
    const report = verifyArtifact({
      type: "pdf",
      filename: "doc.pdf",
      files: [],
      markdown: "# Report",
    });

    expect(report.ok).toBe(true);
    expect(report.coverage).toBe("unchecked");
  });

  it("computes coverage correctly on an artifact WITH errors", () => {
    // ok and coverage are independent. A failed check still RAN, so a project where
    // everything ran and one thing failed is "checked" and not ok.
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: {} }),
        "src/index.ts": `import { db } from "./lib/db-missing";\nexport const a = db;`,
      })
    );

    expect(report.ok).toBe(false);
    expect(report.coverage).toBe("checked");
    expect(report.checks.filter((c) => c.status === "failed")).toHaveLength(1);
    expect(ran(report)).toBe(4);
  });

  it("carries the report's ACTUAL coverage into the attempt record", () => {
    // A FALSE-NEGATIVE TEST WAS REPLACED HERE. The previous version used a report whose
    // coverage was already "checked", so hardcoding the field to "checked" passed it.
    // This fixture is built to be "partial" instead: package.json is malformed, which
    // fails required-files AND makes manifest-coherence skip, so a hardcoded value is
    // wrong by construction.
    const report = verifyArtifact(
      project({
        "package.json": '{ "name": "demo", }' + "\ntrailing garbage",
        "src/index.ts": `export const a = 1;`,
      })
    );

    expect(report.ok).toBe(false);
    expect(report.coverage).toBe("partial");

    const attempt = attemptFromReport(report, "zip");

    expect(attempt.coverage).toBe("partial");
    expect(attempt.ok).toBe(false);
    expect(attempt.stage).toBe("verification");
  });

  it("leaves ok untouched — nothing that passed before now fails", () => {
    // The no-behaviour-change guarantee, asserted rather than assumed. Each of these
    // passed before coverage existed and must still pass.
    const single = verifyArtifact({
      type: "file",
      filename: "x.ts",
      files: [{ path: "x.ts", content: "export const x = 1;" }],
    });
    const python = verifyArtifact(project({ "main.py": "import os\n", "README.md": "# d" }));
    const clean = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "d", dependencies: {} }),
        "src/index.ts": `export const a = 1;`,
      })
    );

    expect([single.ok, python.ok, clean.ok]).toEqual([true, true, true]);
    // And they are now distinguishable, which is the whole point.
    expect([single.coverage, python.coverage, clean.coverage]).toEqual([
      "unchecked",
      "partial",
      "checked",
    ]);
  });
});
