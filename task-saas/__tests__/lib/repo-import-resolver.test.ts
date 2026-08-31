import { describe, it, expect } from "vitest";
import {
  extractImports,
  parseTsconfigAliases,
  resolveImport,
  supportsImports,
  IMPORT_LANGUAGES,
  type AliasConfig,
} from "@/lib/repo/imports";

/**
 * Import extraction and resolution.
 *
 * THE PROPERTY THAT MATTERS MOST is not "resolution is correct" but "a specifier is
 * never silently dropped". Every import lands in exactly one of three states, and the
 * two non-resolving states are distinguishable: `external` means there is genuinely no
 * file here to point at, `unresolved` means one was expected and not found. Collapsing
 * them, or discarding either, would make an edge list that cannot be told apart from a
 * repository with no internal dependencies — the same failure Repository.symbolsExtracted
 * exists to prevent, one level down.
 */

const files = (...paths: string[]): ReadonlySet<string> => new Set(paths);

describe("import extraction", () => {
  it("finds the statement forms that actually appear in source", () => {
    const source = [
      `import fs from "node:fs";`,
      `import { a } from "./a";`,
      `import type { B } from "../types/b";`,
      `import "./side-effect";`,
      `export { c } from "./c";`,
      `export * from "./d";`,
      `const e = require("./e");`,
      `const f = await import("./f");`,
    ].join("\n");

    expect(extractImports(source)).toEqual([
      "node:fs",
      "./a",
      "../types/b",
      "./side-effect",
      "./c",
      "./d",
      "./e",
      "./f",
    ]);
  });

  it("finds a multi-line import list", () => {
    // The single most common formatting in any repository that runs a formatter. A
    // line-anchored `from` pattern alone cannot see it, and missing it would drop most
    // internal edges in this very codebase.
    const source = ["import {", "  alpha,", "  beta,", `} from "./greek";`].join("\n");

    expect(extractImports(source)).toContain("./greek");
  });

  it("records one specifier however many times it is imported", () => {
    // An edge is a fact about a pair of files, not about line count. Two entries would
    // double-count the dependency in anything that later ranks by edge weight.
    const source = [`import a from "./same";`, `import type { T } from "./same";`].join("\n");

    expect(extractImports(source)).toEqual(["./same"]);
  });

  it("yields nothing rather than throwing on input it cannot read", () => {
    expect(extractImports("")).toEqual([]);
    expect(extractImports("not source code at all")).toEqual([]);
  });

  it("covers javascript and typescript, and says so", () => {
    expect(supportsImports("typescript")).toBe(true);
    expect(supportsImports("javascript")).toBe(true);
    expect(supportsImports("python")).toBe(false);
    expect(supportsImports(null)).toBe(false);
    // The constant is what coverage reporting names, so it must not drift silently.
    expect([...IMPORT_LANGUAGES].sort()).toEqual(["javascript", "typescript"]);
  });
});

describe("import resolution", () => {
  it("resolves a relative import with an explicit extension", () => {
    const set = files("src/index.ts", "src/util.ts");

    expect(resolveImport("src/index.ts", "./util.ts", set, null)).toEqual({
      kind: "resolved",
      path: "src/util.ts",
    });
  });

  it("resolves an extension-less import", () => {
    const set = files("src/index.ts", "src/util.ts");

    expect(resolveImport("src/index.ts", "./util", set, null)).toEqual({
      kind: "resolved",
      path: "src/util.ts",
    });
  });

  it("prefers the implementation over its declaration file", () => {
    // Both exist in plenty of published packages. A reader asking what a file depends
    // on wants the code, not the .d.ts shadowing it.
    const set = files("src/index.ts", "src/util.ts", "src/util.d.ts");

    expect(resolveImport("src/index.ts", "./util", set, null)).toEqual({
      kind: "resolved",
      path: "src/util.ts",
    });
  });

  it("resolves a directory to its index file", () => {
    const set = files("src/index.ts", "src/helpers/index.ts");

    expect(resolveImport("src/index.ts", "./helpers", set, null)).toEqual({
      kind: "resolved",
      path: "src/helpers/index.ts",
    });
  });

  it("resolves a parent-directory import", () => {
    const set = files("src/deep/nested/file.ts", "src/shared.ts");

    expect(resolveImport("src/deep/nested/file.ts", "../../shared", set, null)).toEqual({
      kind: "resolved",
      path: "src/shared.ts",
    });
  });

  it("resolves a .js specifier to its TypeScript source", () => {
    // Not an oddity: this is how TypeScript's own guidance says to write relative
    // imports in an ESM package. Treating it literally would drop every internal edge
    // in a repository that follows it.
    const set = files("src/index.ts", "src/util.ts");

    expect(resolveImport("src/index.ts", "./util.js", set, null)).toEqual({
      kind: "resolved",
      path: "src/util.ts",
    });
  });

  it("reports a bare specifier as external, not as a failure", () => {
    const set = files("src/index.ts");

    expect(resolveImport("src/index.ts", "react", set, null)).toEqual({ kind: "external" });
    expect(resolveImport("src/index.ts", "node:fs", set, null)).toEqual({ kind: "external" });
    expect(resolveImport("src/index.ts", "@scope/pkg", set, null)).toEqual({ kind: "external" });
  });

  it("reports a relative import that matches nothing as unresolved, never external", () => {
    // The distinction is the point. "./missing" is a claim about THIS repository, so a
    // miss is a real signal — usually a file the index excluded — and calling it a
    // package would bury it among hundreds of legitimate node_modules edges.
    const set = files("src/index.ts");

    expect(resolveImport("src/index.ts", "./missing", set, null)).toEqual({
      kind: "unresolved",
    });
  });

  it("reports an import that escapes the repository root as unresolved", () => {
    const set = files("src/index.ts");

    expect(resolveImport("src/index.ts", "../../../outside", set, null)).toEqual({
      kind: "unresolved",
    });
  });

  it("resolves a self-import to the file itself", () => {
    // Pathological but real, and the resolver reports it truthfully rather than
    // deciding it is uninteresting. Whether to persist a self-edge belongs to the
    // ingest layer, which does keep it — see the integration test.
    const set = files("src/loop.ts");

    expect(resolveImport("src/loop.ts", "./loop", set, null)).toEqual({
      kind: "resolved",
      path: "src/loop.ts",
    });
  });

  it("resolves both directions of a circular import without special-casing either", () => {
    // A cycle is two ordinary edges. Nothing here needs to detect it, and anything that
    // did would be a traversal concern rather than a resolution one — recorded because
    // a resolver that quietly broke cycles would produce a graph missing real edges.
    const set = files("src/a.ts", "src/b.ts");

    expect(resolveImport("src/a.ts", "./b", set, null)).toEqual({
      kind: "resolved",
      path: "src/b.ts",
    });
    expect(resolveImport("src/b.ts", "./a", set, null)).toEqual({
      kind: "resolved",
      path: "src/a.ts",
    });
  });

  describe("tsconfig path aliases", () => {
    const aliases = (paths: Record<string, string[]>, baseUrl = "."): AliasConfig => ({
      baseUrl,
      paths,
    });

    it("resolves a wildcard alias", () => {
      const set = files("src/index.ts", "lib/db.ts");
      const config = aliases({ "@/*": ["./*"] });

      expect(resolveImport("src/index.ts", "@/lib/db", set, config)).toEqual({
        kind: "resolved",
        path: "lib/db.ts",
      });
    });

    it("resolves an alias through baseUrl", () => {
      const set = files("app/main.ts", "src/lib/db.ts");
      const config = aliases({ "@/*": ["./*"] }, "src");

      expect(resolveImport("app/main.ts", "@/lib/db", set, config)).toEqual({
        kind: "resolved",
        path: "src/lib/db.ts",
      });
    });

    it("resolves an exact, non-wildcard alias", () => {
      const set = files("src/index.ts", "src/config/settings.ts");
      const config = aliases({ settings: ["./src/config/settings"] });

      expect(resolveImport("src/index.ts", "settings", set, config)).toEqual({
        kind: "resolved",
        path: "src/config/settings.ts",
      });
    });

    it("reports an alias that matches a pattern but no file as unresolved", () => {
      // Matching the pattern is a claim that this names something here. A miss is a
      // genuine gap — typically an alias resolved differently by the bundler — and
      // calling it external would hide exactly the case worth investigating.
      const set = files("src/index.ts");
      const config = aliases({ "@/*": ["./*"] });

      expect(resolveImport("src/index.ts", "@/does/not/exist", set, config)).toEqual({
        kind: "unresolved",
      });
    });

    it("leaves a specifier matching no alias as external", () => {
      const set = files("src/index.ts");
      const config = aliases({ "@/*": ["./*"] });

      expect(resolveImport("src/index.ts", "lodash", set, config)).toEqual({ kind: "external" });
    });
  });

  describe("tsconfig parsing", () => {
    it("reads paths and baseUrl", () => {
      const parsed = parseTsconfigAliases(
        JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "@/*": ["./*"] } } })
      );

      expect(parsed).toEqual({ baseUrl: "src", paths: { "@/*": ["./*"] } });
    });

    it("tolerates comments and trailing commas", () => {
      // tsconfig.json is JSONC in practice. A strict parse fails on most real ones, and
      // failing here means silently losing every aliased edge in the repository.
      const source = `{
        // the compiler options
        "compilerOptions": {
          /* module resolution */
          "baseUrl": ".",
          "paths": { "@/*": ["./*"], },
        },
      }`;

      expect(parseTsconfigAliases(source)).toEqual({ baseUrl: ".", paths: { "@/*": ["./*"] } });
    });

    it("does not mistake a // inside a string for a comment", () => {
      const source = `{"compilerOptions":{"baseUrl":"./a//b","paths":{"@/*":["./*"]}}}`;

      expect(parseTsconfigAliases(source)?.baseUrl).toBe("./a//b");
    });

    it("defaults baseUrl when paths are given without one", () => {
      // Legal since TypeScript 4.4, and increasingly common. Refusing it would drop
      // aliases from every modern tsconfig that omits baseUrl.
      const parsed = parseTsconfigAliases(
        JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } })
      );

      expect(parsed).toEqual({ baseUrl: ".", paths: { "@/*": ["./*"] } });
    });

    it("returns null when there is nothing usable, rather than an empty config", () => {
      expect(parseTsconfigAliases("{}")).toBeNull();
      expect(parseTsconfigAliases(`{"compilerOptions":{"strict":true}}`)).toBeNull();
      expect(parseTsconfigAliases("this is not json")).toBeNull();
    });
  });
});
