import type { TreeEntry } from "@/lib/repo/github";

/**
 * What a repository is made of, derived entirely from its file list.
 *
 * Everything here comes from paths and sizes, which the tree endpoint returns in one
 * request. Nothing in this module fetches a file, so detecting structure costs no API
 * budget at all — which is why it runs during ingestion rather than at query time.
 */

/**
 * Extensions worth indexing as source. Everything else is still recorded in the file
 * list (so "what's in this repo" stays honest) but is never a candidate for reading:
 * lockfiles, images and vendored bundles burn a request and a token budget to tell the
 * model nothing.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  cs: "csharp",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
};

/** Manifests that identify the ecosystem, checked in order of specificity. */
const MANIFESTS: ReadonlyArray<{ file: string; ecosystem: string }> = [
  { file: "package.json", ecosystem: "node" },
  { file: "pyproject.toml", ecosystem: "python" },
  { file: "requirements.txt", ecosystem: "python" },
  { file: "go.mod", ecosystem: "go" },
  { file: "Cargo.toml", ecosystem: "rust" },
  { file: "Gemfile", ecosystem: "ruby" },
  { file: "pom.xml", ecosystem: "java" },
  { file: "build.gradle", ecosystem: "java" },
  { file: "composer.json", ecosystem: "php" },
];

/** Conventional entry points, matched against the full path. */
const ENTRY_POINTS: readonly string[] = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.py",
  "src/main.go",
  "src/main.rs",
  "index.ts",
  "index.js",
  "main.py",
  "main.go",
  "main.rs",
  "app/page.tsx",
  "app/layout.tsx",
  "pages/index.tsx",
  "cmd/main.go",
  "manage.py",
];

/**
 * Paths that are never worth reading, regardless of extension. Vendored and generated
 * trees dominate file counts and would otherwise decide the "primary language".
 */
const IGNORED_SEGMENTS: readonly string[] = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  ".next/",
  "out/",
  "target/",
  "__pycache__/",
  ".venv/",
  "site-packages/",
  "coverage/",
  ".git/",
  "third_party/",
  "generated/",
];

export interface RepoStructure {
  /** File counts per detected language, source files only. */
  languages: Record<string, number>;
  /** Dependency manifests found at any depth, nearest the root first. */
  manifests: string[];
  ecosystem: string | null;
  entryPoints: string[];
  /** Command from a manifest when it can be read from the path list alone. */
  testCommand: string | null;
  totalFiles: number;
  sourceFiles: number;
  /**
   * What the user actually got. Absent on snapshots indexed before this existed, which
   * is why it is optional rather than defaulted — "we did not record it" and "we
   * recorded zero" are different claims and must not be collapsed.
   */
  coverage?: IndexCoverage;
}

/**
 * How complete this index is, in the terms a user would ask about.
 *
 * WHY THIS IS RECORDED AT ALL
 * Symbol extraction covers JavaScript and TypeScript. A Python, Go or Rust repository
 * indexes to `status: "ready"` with zero symbols and answers questions from paths
 * alone — usable, measurably weaker, and previously indistinguishable from a fully
 * indexed one. The only trace was `symbolsExtracted: false`, which was written and
 * never read by anything.
 *
 * The fix is honesty, not coverage: these numbers exist so the limitation can be
 * stated, not so it can be hidden behind a status of "ready".
 */
export interface IndexCoverage {
  /** Rows written, including files with no recognised language. */
  indexedFiles: number;
  /** Files whose language the extractor supports — the ceiling on symbol coverage. */
  symbolEligibleFiles: number;
  /** Files that actually contributed at least one symbol. */
  filesWithSymbols: number;
  /** Recognised languages present, whether or not symbols could be extracted. */
  languages: string[];
  /** Recognised languages present that the extractor does not cover. */
  languagesWithoutSymbols: string[];
  /**
   * False when extraction never ran — an unsupported primary language, or an archive
   * that could not be read. Distinct from running and finding nothing.
   */
  symbolsExtracted: boolean;

  /**
   * Import-graph coverage. Reported separately from symbol coverage because the two
   * can differ: a repository can have its exports read and its imports not, and a
   * single "covered" flag would hide which half is missing.
   *
   * Optional so a snapshot indexed before edges existed parses as itself rather than
   * as a repository whose imports were parsed and found to be zero. That distinction
   * is the entire reason this block exists — see FileEdge in the schema.
   */
  importsExtracted?: boolean;
  /** Files whose language this extractor parses — the ceiling on edge coverage. */
  importEligibleFiles?: number;
  /** Files that contributed at least one edge of any kind. */
  filesWithImports?: number;
  /** Edges pointing at another file in this snapshot. */
  resolvedEdges?: number;
  /** Edges naming a package or builtin: real imports with nothing here to point at. */
  externalEdges?: number;
  /**
   * Edges that looked like they named a file here and did not. Worth surfacing rather
   * than burying: a high count usually means an alias this pipeline resolves
   * differently from the repository's own bundler.
   */
  unresolvedEdges?: number;
  /** Recognised languages present whose imports this extractor does not parse. */
  languagesWithoutImports?: string[];
  /**
   * Whether a root tsconfig's `paths` were loaded. False with a high unresolvedEdges
   * count is the signature of a repo whose aliases were missed entirely.
   */
  tsconfigAliasesLoaded?: boolean;
}

/**
 * Coverage as one sentence, or null when there is nothing worth saying.
 *
 * Null on a fully covered index: a message that always appears is noise, and a user
 * whose JavaScript repo indexed completely does not need telling that JavaScript is
 * supported. It speaks up only where expectations would otherwise be wrong.
 *
 * Built here rather than in the route so the API response and any UI say the same
 * thing. The numbers are counts, not adjectives — "312 files were indexed by path and
 * content only" is checkable; "partial coverage" is not.
 */
export function describeCoverage(coverage: IndexCoverage | undefined): string | null {
  if (!coverage) return null;

  const { indexedFiles, symbolEligibleFiles, filesWithSymbols, languagesWithoutSymbols } = coverage;
  const withoutSymbols = indexedFiles - filesWithSymbols;
  if (withoutSymbols <= 0) return null;

  const file = (n: number): string => `${n.toLocaleString("en-US")} file${n === 1 ? "" : "s"}`;
  const head = `Indexed ${file(indexedFiles)}.`;

  // Extraction never ran: an unsupported primary language, or an unreadable archive.
  // Naming the supported set is the actionable part — it says what WOULD work.
  if (!coverage.symbolsExtracted || symbolEligibleFiles === 0) {
    const found =
      languagesWithoutSymbols.length > 0
        ? ` Detected: ${languagesWithoutSymbols.join(", ")}.`
        : "";
    return (
      `${head} Symbol extraction currently supports ${SYMBOL_LANGUAGE_LABEL} only, so all ` +
      `${file(indexedFiles)} were indexed by path and content only.${found} ` +
      `Answers still work, but questions naming a function or class are matched less precisely.`
    );
  }

  return (
    `${head} Symbol extraction currently supports ${SYMBOL_LANGUAGE_LABEL} only, so ` +
    `${file(withoutSymbols)} were indexed by path and content only.`
  );
}

/** Human-facing name for the supported set. Kept beside describeCoverage, its only use. */
const SYMBOL_LANGUAGE_LABEL = "JavaScript and TypeScript";

/** True for paths inside vendored or generated trees. */
export function isIgnoredPath(path: string): boolean {
  const normalized = `${path.toLowerCase()}`;
  return IGNORED_SEGMENTS.some(
    (segment) => normalized.startsWith(segment) || normalized.includes(`/${segment}`)
  );
}

/** The language for a path, or null when the extension is not source we index. */
export function languageForPath(path: string): string | null {
  if (isIgnoredPath(path)) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Describe a repository from its tree.
 *
 * `testCommand` stays null here on purpose: reading it means fetching and parsing
 * package.json, which is a request and a decision about which script counts. The file
 * list can only prove a manifest EXISTS, so that is all this claims. Detecting the
 * command properly belongs with the step that reads manifests, not this one.
 */
export function detectStructure(entries: readonly TreeEntry[]): RepoStructure {
  const languages: Record<string, number> = {};
  let sourceFiles = 0;

  for (const entry of entries) {
    const language = languageForPath(entry.path);
    if (!language) continue;
    languages[language] = (languages[language] ?? 0) + 1;
    sourceFiles++;
  }

  const paths = new Set(entries.map((e) => e.path));
  const manifests: string[] = [];
  let ecosystem: string | null = null;

  for (const { file, ecosystem: eco } of MANIFESTS) {
    // Root manifest decides the ecosystem; nested ones are still worth recording.
    for (const entry of entries) {
      if (isIgnoredPath(entry.path)) continue;
      const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      if (base !== file) continue;
      manifests.push(entry.path);
      if (!ecosystem) ecosystem = eco;
    }
  }

  const entryPoints = ENTRY_POINTS.filter((candidate) => paths.has(candidate));

  return {
    languages,
    manifests: manifests.sort((a, b) => a.split("/").length - b.split("/").length),
    ecosystem,
    entryPoints,
    testCommand: null,
    totalFiles: entries.length,
    sourceFiles,
  };
}

/**
 * The repository's dominant language, or null when it has no indexable source.
 *
 * By file count, which is crude but honest: a repo with 300 TypeScript files and 4
 * shell scripts is a TypeScript repo. Ignored trees are already excluded upstream, so
 * a vendored dependency cannot win this.
 */
export function primaryLanguage(structure: RepoStructure): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [language, count] of Object.entries(structure.languages)) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}
