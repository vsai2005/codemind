import { describe, it, expect } from "vitest";
import { verifyArtifact, describeWarnings, type CheckName } from "@/lib/artifacts/verify";
import type { NormalizedArtifact } from "@/lib/artifacts/types";

/**
 * Static verification of a generated project.
 *
 * WHAT THESE TESTS ARE REALLY PROTECTING
 * Not "does the checker find the bug" — that is easy to assert and easy to fake. The
 * property that matters is that a check which did not run says so. Every assertion
 * about a passing project therefore also asserts the check's STATUS, because a
 * verifier that silently skips a check and reports `ok: true` is worse than no verifier
 * at all: it converts an unknown into a false assurance, and something downstream will
 * eventually route on it.
 */

const project = (files: Record<string, string>): NormalizedArtifact => ({
  type: "zip",
  filename: "project.zip",
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  nameSource: "model",
});

const statusOf = (
  report: ReturnType<typeof verifyArtifact>,
  check: CheckName
): string => report.checks.find((c) => c.check === check)!.status;

const codes = (findings: Array<{ code: string }>): string[] => findings.map((f) => f.code);

/** A project that is coherent in every way the checker understands. */
const CLEAN = {
  "package.json": JSON.stringify({
    name: "demo",
    dependencies: { react: "^18.0.0" },
  }),
  "src/index.ts": `import React from "react";\nimport { helper } from "./helper";\nexport const app = () => helper(React);`,
  "src/helper.ts": `export function helper(x: unknown) {\n  return x;\n}`,
};

describe("a clean project", () => {
  it("passes, and every check reports that it actually ran", () => {
    const report = verifyArtifact(project(CLEAN));

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);

    // The assurance is only worth what the checks are. All four must say "passed",
    // not "skipped" — an all-skipped report is also ok:true and means nothing.
    for (const check of report.checks) {
      expect(check.status).toBe("passed");
      expect(check.skippedReason).toBeNull();
    }
    expect(report.checks).toHaveLength(4);
  });

  it("carries a schema version, because stored reports outlive the code", () => {
    expect(verifyArtifact(project(CLEAN)).version).toBe(1);
  });
});

describe("completeness: internal imports", () => {
  it("reports a relative import that no generated file provides", () => {
    // The failure this whole module exists for: every file is individually complete
    // and well-formed, and the project does not run.
    const report = verifyArtifact(
      project({
        ...CLEAN,
        "src/index.ts": `import { db } from "./lib/db";\nexport const app = () => db;`,
      })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("unresolved-internal-import");
    expect(report.errors[0].file).toBe("src/index.ts");
    expect(report.errors[0].detail?.specifier).toBe("./lib/db");
    expect(statusOf(report, "imports-resolve")).toBe("failed");
  });

  it("does not treat an external package as unresolved", () => {
    const report = verifyArtifact(project(CLEAN));

    expect(codes(report.errors)).not.toContain("unresolved-internal-import");
  });

  it("resolves an extension-less import to the file that provides it", () => {
    // "./helper" naming helper.ts is the overwhelmingly common form. Failing to
    // resolve it would make the checker reject nearly every correct project.
    const report = verifyArtifact(project(CLEAN));

    expect(statusOf(report, "imports-resolve")).toBe("passed");
  });

  it("resolves through the project's own tsconfig aliases", () => {
    // The aliases come from the GENERATED tsconfig, not from this repository's.
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo" }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
        }),
        "src/index.ts": `import { helper } from "@/helper";\nexport const app = helper;`,
        "src/helper.ts": `export const helper = 1;`,
      })
    );

    expect(report.ok).toBe(true);
    expect(statusOf(report, "imports-resolve")).toBe("passed");
  });

  it("skips rather than passes when there is no code to scan", () => {
    const report = verifyArtifact(
      project({ "README.md": "# docs", "data.csv": "a,b\n1,2" })
    );

    expect(statusOf(report, "imports-resolve")).toBe("skipped");
    expect(
      report.checks.find((c) => c.check === "imports-resolve")!.skippedReason
    ).toMatch(/JavaScript or TypeScript/);
  });
});

describe("manifest coherence", () => {
  it("reports a package that is imported but not declared", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: {} }),
        "src/index.ts": `import axios from "axios";\nexport const a = axios;`,
      })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("missing-dependency");
    expect(report.errors[0].detail?.package).toBe("axios");
  });

  it("reduces a subpath import to its package name", () => {
    // "next/navigation" is the `next` package. Reporting the subpath as missing would
    // be a false positive on almost every Next.js project.
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: { next: "14" } }),
        "app/page.tsx": `import { useRouter } from "next/navigation";\nexport default function P() { return useRouter(); }`,
      })
    );

    expect(codes(report.errors)).not.toContain("missing-dependency");
  });

  it("handles a scoped package", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({
          name: "demo",
          dependencies: { "@prisma/client": "5" },
        }),
        "prisma/schema.prisma": "generator client { provider = \"prisma-client-js\" }",
        "src/db.ts": `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();`,
      })
    );

    expect(codes(report.errors)).not.toContain("missing-dependency");
  });

  it("never reports a node builtin as a missing dependency", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo" }),
        "src/index.ts": `import fs from "node:fs";\nimport path from "path";\nexport const a = [fs, path];`,
      })
    );

    expect(codes(report.errors)).not.toContain("missing-dependency");
  });

  it("reports a declared-but-unimported dependency as a WARNING, not an error", () => {
    // Blocking here would reject correct projects: CLI tools, framework plugins and
    // type packages are legitimately never imported by name.
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({
          name: "demo",
          dependencies: { react: "^18.0.0" },
          devDependencies: { eslint: "^9.0.0" },
        }),
        "src/index.ts": `import React from "react";\nexport const a = React;`,
      })
    );

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(codes(report.warnings)).toContain("unused-dependency");
    expect(report.warnings[0].detail?.package).toBe("eslint");
    // A check that produced only warnings still passed.
    expect(statusOf(report, "manifest-coherence")).toBe("passed");
  });

  it("skips rather than passes when there is no package.json", () => {
    const report = verifyArtifact(
      project({ "main.py": "print('hi')", "README.md": "# docs" })
    );

    expect(statusOf(report, "manifest-coherence")).toBe("skipped");
  });
});

describe("required files", () => {
  it("reports a package.json that is not valid JSON", () => {
    const report = verifyArtifact(
      project({ "package.json": `{ "name": "demo", }` + "\ntrailing garbage" })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("package-json-invalid");
    // And manifest coherence must SKIP rather than pass: it had nothing to read.
    expect(statusOf(report, "manifest-coherence")).toBe("skipped");
  });

  it("reports a Prisma project with no schema", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({
          name: "demo",
          dependencies: { "@prisma/client": "5" },
        }),
        "src/db.ts": `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();`,
      })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("prisma-schema-missing");
  });

  it("reports a Next.js project with no app or pages directory", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: { next: "14" } }),
        "src/thing.ts": `export const a = 1;`,
      })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("next-entry-missing");
  });

  it("accepts a Next.js project routed from pages/", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: { next: "14" } }),
        "pages/index.tsx": `export default function Home() { return null; }`,
      })
    );

    expect(codes(report.errors)).not.toContain("next-entry-missing");
  });
});

describe("structural sanity", () => {
  it("reports an empty file", () => {
    const report = verifyArtifact(project({ ...CLEAN, "src/empty.ts": "   \n  " }));

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("empty-file");
  });

  it("reports a file containing only a markdown fence", () => {
    // The case existing validation cannot see: non-empty, an even number of fences,
    // no dangling token, no unbalanced bracket — and no code.
    const report = verifyArtifact(
      project({ ...CLEAN, "src/stub.ts": "```typescript\n```" })
    );

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("fence-only-file");
  });

  it("does not mistake a file that merely contains a fenced block", () => {
    const report = verifyArtifact(
      project({ ...CLEAN, "README.md": "# Demo\n\n```ts\nconst a = 1;\n```\n\nDone." })
    );

    expect(codes(report.errors)).not.toContain("fence-only-file");
  });

  it("reports a duplicate path", () => {
    const artifact: NormalizedArtifact = {
      type: "zip",
      filename: "p.zip",
      files: [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "src/a.ts", content: "export const a = 2;" },
      ],
      nameSource: "model",
    };

    const report = verifyArtifact(artifact);

    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("duplicate-path");
  });
});

describe("artifacts that are not multi-file projects", () => {
  it("marks every check skipped for a pdf, rather than passing them", () => {
    const report = verifyArtifact({
      type: "pdf",
      filename: "doc.pdf",
      files: [],
      markdown: "# Report",
      nameSource: "model",
    });

    expect(report.ok).toBe(true);
    // ok:true with everything skipped is the honest shape. Reporting "passed" would
    // claim four checks ran on a document that has no files at all.
    for (const check of report.checks) {
      expect(check.status).toBe("skipped");
      expect(check.skippedReason).toBeTruthy();
    }
  });

  it("marks every check skipped for a single-file artifact", () => {
    const report = verifyArtifact({
      type: "file",
      filename: "script.ts",
      files: [{ path: "script.ts", content: `import { x } from "./missing";\nexport const y = x;` }],
      nameSource: "model",
    });

    // Its import cannot resolve, and that is not a defect: the user asked for one file,
    // not a project. Reporting it as broken would be a lie about the request.
    expect(report.ok).toBe(true);
    expect(statusOf(report, "imports-resolve")).toBe("skipped");
  });
});

describe("describeWarnings", () => {
  it("returns null when there is nothing to say", () => {
    expect(describeWarnings(verifyArtifact(project(CLEAN)))).toBeNull();
  });

  it("names each warning so the user can act on it", () => {
    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: { lodash: "4" } }),
        "src/index.ts": `export const a = 1;`,
      })
    );

    const note = describeWarnings(report);

    expect(note).toContain("lodash");
    expect(note).toMatch(/do not block|none of which block/i);
  });

  it("caps the list rather than printing dozens of lines", () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 10; i++) deps[`pkg-${i}`] = "1";

    const report = verifyArtifact(
      project({
        "package.json": JSON.stringify({ name: "demo", dependencies: deps }),
        "src/index.ts": `export const a = 1;`,
      })
    );

    const note = describeWarnings(report, 3)!;

    expect(note.split("\n")).toHaveLength(5); // header + 3 + "and N more"
    expect(note).toContain("and 7 more");
  });
});
