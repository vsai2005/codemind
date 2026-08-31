import { describe, it, expect } from "vitest";
import { detectEntryPoints } from "@/lib/repo/structure";
import { hubFiles, type FileEdgeLink, type IndexedFile } from "@/lib/repo/selection";

/**
 * Entry-point detection.
 *
 * WHY THE HARDCODED LIST HAD TO GO
 * It named `src/index.ts` and not `source/index.ts`, so sindresorhus/ky detected no
 * entry point at all and its fallback branch could not expand along imports even after
 * expansion was proven to work. A literal list is wrong one directory name at a time.
 *
 * TIER 1 (manifest-declared) IS ABSENT ON PURPOSE and these tests say so rather than
 * pretending otherwise: package.json content is not stored anywhere — RepositoryFile
 * holds paths and sizes, never bodies — so reading `main`/`module`/`exports`/`bin`
 * would cost a GitHub request per turn. The cases below are the two tiers that can be
 * implemented without one.
 */

const paths = (...p: string[]): ReadonlySet<string> => new Set(p);

const file = (path: string): IndexedFile => ({ path, size: 400, language: "typescript" });
const link = (fromPath: string, toPath: string): FileEdgeLink => ({ fromPath, toPath });

describe("tier 2: conventional layouts", () => {
  it("detects source/index.ts — the ky case, and the acceptance criterion", () => {
    // The exact layout the old list missed.
    expect(detectEntryPoints(paths("source/index.ts", "source/core/Ky.ts"))).toEqual([
      "source/index.ts",
    ]);
  });

  it("detects src/, lib/, app/ and root layouts", () => {
    expect(detectEntryPoints(paths("src/index.ts"))).toEqual(["src/index.ts"]);
    expect(detectEntryPoints(paths("lib/index.js"))).toEqual(["lib/index.js"]);
    expect(detectEntryPoints(paths("app/main.ts"))).toEqual(["app/main.ts"]);
    expect(detectEntryPoints(paths("index.ts"))).toEqual(["index.ts"]);
  });

  it("prefers the root entry when a repository has both", () => {
    // fallbackFiles reads these in order, and the root file is the one a reader opens.
    const found = detectEntryPoints(paths("src/index.ts", "index.ts"));

    expect(found[0]).toBe("index.ts");
  });

  it("covers non-JavaScript ecosystems", () => {
    expect(detectEntryPoints(paths("main.go"))).toEqual(["main.go"]);
    expect(detectEntryPoints(paths("src/main.rs"))).toEqual(["src/main.rs"]);
    expect(detectEntryPoints(paths("manage.py"))).toEqual(["manage.py"]);
    expect(detectEntryPoints(paths("cmd/main.go"))).toEqual(["cmd/main.go"]);
  });

  it("keeps framework layouts that no index/main pattern would generate", () => {
    expect(detectEntryPoints(paths("app/page.tsx"))).toEqual(["app/page.tsx"]);
    expect(detectEntryPoints(paths("pages/index.tsx"))).toEqual(["pages/index.tsx"]);
  });

  it("finds nothing in a repository that has no conventional entry", () => {
    // Not an error. This is the state tier 3 exists for, and the state the coverage
    // note has to report when tier 3 also finds nothing.
    expect(detectEntryPoints(paths("weird/thing.ts", "other/stuff.ts"))).toEqual([]);
  });

  it("is deterministic and does not depend on set insertion order", () => {
    const forward = detectEntryPoints(paths("src/index.ts", "index.ts", "lib/index.ts"));
    const reversed = detectEntryPoints(paths("lib/index.ts", "index.ts", "src/index.ts"));

    expect(reversed).toEqual(forward);
  });
});

describe("tier 3: structural hubs", () => {
  const pool = [file("src/a.ts"), file("src/b.ts"), file("src/core.ts"), file("src/leaf.ts")];

  it("ranks the most-imported file first", () => {
    // NAMES CHOSEN SO PATH ORDER OPPOSES THE ANSWER. The hub is "src/zeta.ts" and the
    // less-imported file is "src/alpha.ts", so if the inbound comparator were removed
    // the alphabetical tie-break would put alpha first and the test would fail.
    // An earlier version used core/leaf, where path order happened to agree with
    // inbound order — so deleting the ranking rule left it green.
    const named = [file("src/a.ts"), file("src/b.ts"), file("src/zeta.ts"), file("src/alpha.ts")];
    const edges = [
      link("src/a.ts", "src/zeta.ts"),
      link("src/b.ts", "src/zeta.ts"),
      link("src/a.ts", "src/alpha.ts"),
    ];

    expect(hubFiles(named, edges, 2)[0]).toBe("src/zeta.ts");
  });

  it("prefers the file that imports less when inbound counts tie", () => {
    // Between two equally-imported files, the one pulling in less sits nearer the
    // bottom of the stack and explains more per line.
    //
    // Again the names oppose the answer: the low-outbound file is "src/zzz.ts" and the
    // high-outbound one is "src/aaa.ts", so removing the outbound comparator lets the
    // path tie-break pick aaa and the test fails. Two earlier versions of this test
    // passed under that mutation — first because every file tied on both counts, then
    // because path order agreed with the intended answer.
    const named = [
      file("src/a.ts"),
      file("src/b.ts"),
      file("src/aaa.ts"),
      file("src/zzz.ts"),
      file("src/x.ts"),
    ];
    const edges = [
      link("src/a.ts", "src/aaa.ts"),
      link("src/b.ts", "src/aaa.ts"),
      link("src/a.ts", "src/zzz.ts"),
      link("src/b.ts", "src/zzz.ts"),
      link("src/aaa.ts", "src/x.ts"),
    ];

    const ranked = hubFiles(named, edges, 3);

    expect(ranked).toContain("src/zzz.ts");
    expect(ranked).toContain("src/aaa.ts");
    expect(ranked.indexOf("src/zzz.ts")).toBeLessThan(ranked.indexOf("src/aaa.ts"));
  });

  it("returns nothing when the repository has no edges", () => {
    // No graph means no structural evidence. Inventing an entry point from path shape
    // is the guess this tier exists to replace.
    expect(hubFiles(pool, [], 3)).toEqual([]);
  });

  it("ignores a self-edge, which is evidence of nothing", () => {
    expect(hubFiles(pool, [link("src/a.ts", "src/a.ts")], 3)).toEqual([]);
  });

  it("never returns a file with no recognised source language", () => {
    const withDoc = [...pool, { path: "README.md", size: 100, language: null }];
    const edges = [link("src/a.ts", "README.md"), link("src/b.ts", "README.md")];

    expect(hubFiles(withDoc, edges, 3)).not.toContain("README.md");
  });

  it("ranks identically when the edge list is shuffled", () => {
    const edges = [
      link("src/a.ts", "src/core.ts"),
      link("src/b.ts", "src/core.ts"),
      link("src/a.ts", "src/leaf.ts"),
      link("src/b.ts", "src/leaf.ts"),
    ];

    expect(hubFiles(pool, [...edges].reverse(), 3)).toEqual(hubFiles(pool, edges, 3));
  });
});
