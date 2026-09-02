import { describe, it, expect } from "vitest";
import { verifyArtifact } from "@/lib/artifacts/verify";
import type { NormalizedArtifact } from "@/lib/artifacts/types";

/**
 * Node built-ins are dependencies of nothing.
 *
 * THE DEFECT THIS PINS DOWN, measured on a 42-case run.
 * The builtin lookup tested the whole specifier after stripping `node:`, so a subpath
 * never matched: `node:assert/strict` became "assert/strict", missed the set, and was
 * reported as an undeclared dependency on "assert". `node:test` missed for a different
 * reason — it was absent from the list, having been added to Node after the list was
 * written. A real generated project was rejected for importing its own test runner.
 *
 * FIXTURES USE SUBPATHS AND `node:` FORMS ON PURPOSE. A fixture importing plain `fs`
 * passes both before and after this change and proves nothing — that shape is exactly
 * what the original tests used, which is how this shipped.
 */

const zip = (files: { path: string; content: string }[]): NormalizedArtifact =>
  ({ type: "zip", filename: "p.zip", files }) as NormalizedArtifact;

/** package.json declaring nothing, so any real dependency would be reported. */
const EMPTY_MANIFEST = {
  path: "package.json",
  content: JSON.stringify({ name: "p", version: "1.0.0", scripts: { test: "node --test" } }),
};

const missingDeps = (artifact: NormalizedArtifact): string[] =>
  verifyArtifact(artifact)
    .errors.filter((e) => e.code === "missing-dependency")
    .map((e) => e.message);

describe("the node: prefix", () => {
  it("accepts node:test, the exact import that was rejected", () => {
    // From the real generation: test/bus.test.ts imported its runner and was refused.
    const report = verifyArtifact(
      zip([
        EMPTY_MANIFEST,
        {
          path: "test/bus.test.ts",
          content: 'import { describe, it } from "node:test";\ndescribe("x", () => {});',
        },
      ])
    );

    expect(missingDeps(zip([]))).toEqual([]);
    expect(report.errors.filter((e) => e.code === "missing-dependency")).toEqual([]);
  });

  it("accepts a node: subpath, which the whole-specifier lookup could never match", () => {
    // "node:assert/strict" -> "assert/strict" was not in the set, so it fell through
    // to "assert". The subpath is the whole point of this fixture.
    const errors = missingDeps(
      zip([
        EMPTY_MANIFEST,
        { path: "test/a.ts", content: 'import assert from "node:assert/strict";\nassert.ok(1);' },
      ])
    );

    expect(errors).toEqual([]);
  });

  it("accepts node:fs/promises, which is common enough to have been rejecting real work", () => {
    const errors = missingDeps(
      zip([
        EMPTY_MANIFEST,
        { path: "src/a.ts", content: 'import { readFile } from "node:fs/promises";\nreadFile("x");' },
      ])
    );

    expect(errors).toEqual([]);
  });

  it("accepts a node: module the list has never heard of", () => {
    // The prefix decides, not the list. A rule that depends on the set falls behind
    // every Node release; this one cannot.
    const errors = missingDeps(
      zip([
        EMPTY_MANIFEST,
        { path: "src/a.ts", content: 'import { DatabaseSync } from "node:sqlite";\nnew DatabaseSync(":memory:");' },
      ])
    );

    expect(errors).toEqual([]);
  });
});

describe("bare specifiers without the prefix", () => {
  it("accepts an unprefixed builtin subpath", () => {
    // "fs/promises" -> root "fs". Broken before this change for the same reason as the
    // node: form, and unprefixed imports are still ordinary in JS projects.
    const errors = missingDeps(
      zip([
        EMPTY_MANIFEST,
        { path: "src/a.js", content: 'const { readFile } = require("fs/promises");\nreadFile("x");' },
      ])
    );

    expect(errors).toEqual([]);
  });

  it("accepts a plain unprefixed builtin", () => {
    const errors = missingDeps(
      zip([EMPTY_MANIFEST, { path: "src/a.js", content: 'const path = require("path");\npath.join("a");' }])
    );

    expect(errors).toEqual([]);
  });
});

describe("real missing dependencies are still reported", () => {
  it("still catches an undeclared package", () => {
    // The check must not have been softened into uselessness — this is the behaviour
    // the constructed X-missing-dependency case depends on.
    const errors = missingDeps(
      zip([EMPTY_MANIFEST, { path: "src/a.ts", content: 'import axios from "axios";\naxios.get("/");' }])
    );

    expect(errors.join(" ")).toMatch(/axios/);
  });

  it("still catches an undeclared package imported by subpath", () => {
    const errors = missingDeps(
      zip([
        EMPTY_MANIFEST,
        { path: "src/a.ts", content: 'import x from "lodash/debounce";\nx(() => {});' },
      ])
    );

    expect(errors.join(" ")).toMatch(/lodash/);
  });

  it("treats bare `test` as a package, not the runtime's test runner", () => {
    // THE DISTINCTION THAT KEEPS THIS HONEST. `test` is deliberately absent from the
    // builtin set: node:test needs its prefix, while bare `test` is a real package on
    // npm. Adding "test" to the list would have fixed the reported symptom and hidden
    // a genuine missing dependency in any project importing that package.
    const errors = missingDeps(
      zip([EMPTY_MANIFEST, { path: "src/a.ts", content: 'import t from "test";\nt();' }])
    );

    expect(errors.join(" ")).toMatch(/"test"/);
  });

  it("still catches an undeclared scoped package", () => {
    const errors = missingDeps(
      zip([
        EMPTY_MANIFEST,
        { path: "src/a.ts", content: 'import { z } from "@scope/pkg/sub";\nz();' },
      ])
    );

    expect(errors.join(" ")).toMatch(/@scope\/pkg/);
  });

  it("does not mistake a scoped package for a builtin", () => {
    // "@fs/anything" starts with "@", so the root-segment test must not run on it —
    // otherwise a scope that happens to be named like a builtin would be waved through.
    const errors = missingDeps(
      zip([EMPTY_MANIFEST, { path: "src/a.ts", content: 'import x from "@fs/promises";\nx();' }])
    );

    expect(errors.join(" ")).toMatch(/@fs\/promises/);
  });
});
