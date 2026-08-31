import { describe, it, expect } from "vitest";
import { describeCoverage, detectStructure, languageForPath, type IndexCoverage } from "@/lib/repo/structure";
import { supportsSymbols, SYMBOL_LANGUAGES } from "@/lib/repo/symbols";
import { scoreFiles, fallbackFiles, type IndexedFile } from "@/lib/repo/selection";

/**
 * Honesty about index coverage.
 *
 * Symbol extraction understands JavaScript and TypeScript. `languageForPath` recognises
 * fifteen languages, so thirteen of them index to `status: "ready"` with zero symbols
 * and answer questions from paths alone — usable, measurably weaker, and previously
 * indistinguishable from a complete index. The only record was `symbolsExtracted:
 * false`, which was written by ingestion and read by nothing.
 *
 * The fix is not more extractors. It is that the numbers reach the user.
 */

/** A pure-Python repository shape: no JS or TS anywhere. */
const PYTHON_TREE = [
  { path: "src/parser.py", blobSha: "a", size: 4200 },
  { path: "src/lexer.py", blobSha: "b", size: 3100 },
  { path: "src/__init__.py", blobSha: "c", size: 120 },
  { path: "tests/test_parser.py", blobSha: "d", size: 2400 },
  { path: "pyproject.toml", blobSha: "e", size: 800 },
  { path: "README.md", blobSha: "f", size: 5000 },
];

/** What ingest computes, reproduced from the same inputs it uses. */
function coverageFor(tree: typeof PYTHON_TREE, symbolsByPath: Map<string, string[]> = new Map()): IndexCoverage {
  const rows = tree.map((e) => ({
    path: e.path,
    language: languageForPath(e.path),
    symbols: symbolsByPath.get(e.path) ?? [],
    internalSymbols: [] as string[],
  }));
  const languages = Array.from(
    new Set(rows.map((r) => r.language).filter((l): l is string => l !== null))
  ).sort();

  return {
    indexedFiles: rows.length,
    symbolEligibleFiles: rows.filter((r) => supportsSymbols(r.language)).length,
    filesWithSymbols: rows.filter((r) => r.symbols.length > 0 || r.internalSymbols.length > 0).length,
    languages,
    languagesWithoutSymbols: languages.filter((l) => !supportsSymbols(l)),
    symbolsExtracted: symbolsByPath.size > 0,
    /**
     * Present so this fixture describes a MODERN index.
     *
     * Left off, `importsExtracted` is undefined, which coverageLimitations correctly
     * reads as "indexed before import extraction existed" — a real limitation worth
     * reporting, and one that made the fully-covered case stop being silent. The
     * fixture was the thing out of date, not the assertion.
     */
    importsExtracted: symbolsByPath.size > 0,
    filesWithIncompleteImportScan: 0,
  };
}

describe("index coverage on a repository with no JS/TS", () => {
  it("still detects the repository structure", () => {
    // The index is real. Nothing about an unsupported language stops ingestion.
    const structure = detectStructure(PYTHON_TREE);

    expect(structure.languages.python).toBe(4);
    expect(structure.sourceFiles).toBe(4);
    expect(structure.totalFiles).toBe(6);
  });

  it("reports zero symbol coverage honestly rather than claiming none is needed", () => {
    const coverage = coverageFor(PYTHON_TREE);

    expect(coverage.indexedFiles).toBe(6);
    // Nothing was eligible, so nothing having symbols is not a failure — but it must
    // not be reported as success either.
    expect(coverage.symbolEligibleFiles).toBe(0);
    expect(coverage.filesWithSymbols).toBe(0);
    expect(coverage.symbolsExtracted).toBe(false);
    expect(coverage.languages).toContain("python");
    expect(coverage.languagesWithoutSymbols).toContain("python");
  });

  it("says so in a sentence, naming counts and the supported languages", () => {
    const note = describeCoverage(coverageFor(PYTHON_TREE));

    expect(note).not.toBeNull();
    expect(note).toMatch(/6 files/);
    expect(note).toMatch(/JavaScript and TypeScript/);
    // The actionable half: what still works, so the user is informed rather than alarmed.
    expect(note).toMatch(/path and content only/i);
  });

  it("stays silent when there is nothing to disclose", () => {
    // A fully covered JS repository needs no message; one that always appears is one
    // nobody reads.
    const jsTree = [
      { path: "index.js", blobSha: "a", size: 100 },
      { path: "lib/util.js", blobSha: "b", size: 100 },
    ];
    const symbols = new Map([
      ["index.js", ["pLimit"]],
      ["lib/util.js", ["helper"]],
    ]);

    expect(describeCoverage(coverageFor(jsTree, symbols))).toBeNull();
  });

  it("says nothing when coverage was never recorded", () => {
    // Snapshots indexed before coverage existed. "Not measured" and "measured zero"
    // are different claims, and reporting the second for the first would be a
    // confident lie about an old index.
    expect(describeCoverage(undefined)).toBeNull();
  });

  it("keeps the reported supported set in step with the extractor", () => {
    // The sentence names languages. If SYMBOL_LANGUAGES ever grows, a hardcoded
    // sentence would keep telling users something untrue.
    expect(SYMBOL_LANGUAGES).toEqual(["javascript", "typescript"]);
    expect(supportsSymbols("python")).toBe(false);
    expect(supportsSymbols("go")).toBe(false);
  });
});

describe("selection still works without symbols", () => {
  // Every Python file, symbols empty — exactly what ingestion writes for this repo.
  const PYTHON_INDEX: IndexedFile[] = [
    { path: "src/parser.py", size: 4200, language: "python", symbols: [], internalSymbols: [] },
    { path: "src/lexer.py", size: 3100, language: "python", symbols: [], internalSymbols: [] },
    { path: "tests/test_parser.py", size: 2400, language: "python", symbols: [], internalSymbols: [] },
    { path: "README.md", size: 5000, language: null, symbols: [], internalSymbols: [] },
  ];

  it("scores on path alone when a question names a file's subject", () => {
    // Path and basename matching are language-agnostic, so the weaker index is still
    // an index — "degraded" must not mean "returns nothing".
    const scored = scoreFiles(PYTHON_INDEX, "where is the lexer implemented");

    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].path).toBe("src/lexer.py");
  });

  it("falls back to real source files, never to the README", () => {
    // The fallback runs on exactly the vague questions a symbol-less index handles
    // worst, so this is the path that matters most here.
    const chosen = fallbackFiles(PYTHON_INDEX, ["src/parser.py"], 2);

    expect(chosen.map((c) => c.path)).toContain("src/parser.py");
    expect(chosen.map((c) => c.path)).not.toContain("README.md");
  });
});
