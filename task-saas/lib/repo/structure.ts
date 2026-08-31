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
/**
 * Conventional entry-point candidates, generated rather than listed.
 *
 * The hand-written list this replaces missed ordinary layouts. sindresorhus/ky puts its
 * entry at `source/index.ts`; the list had `src/index.ts` and nothing else close, so ky
 * detected NO entry point and its fallback branch could not expand along imports even
 * after expansion was proven to work. A literal list will keep being wrong, one
 * directory name at a time.
 *
 * Generating the cross product of the directories and basenames people actually use,
 * across the extensions ingestion already recognises, covers the same ground without
 * needing an edit per convention.
 *
 * ORDER IS MEANINGFUL: fallbackFiles reads entry points in order, so the outer loop is
 * directory (root first, then the common source roots) and the inner loops are basename
 * then extension. A repository with both `index.ts` and `src/index.ts` gets the root one
 * first, which is the one a reader opens.
 */
const ENTRY_POINT_DIRECTORIES: readonly string[] = ["", "src", "source", "lib", "app"];

/** Basenames that mean "start here" across ecosystems. */
const ENTRY_POINT_BASENAMES: readonly string[] = ["index", "main"];

/**
 * Extensions tried, in preference order.
 *
 * A subset of LANGUAGE_BY_EXTENSION and deliberately ordered rather than derived from
 * it: object key order is not a contract, and detection that reshuffled when someone
 * added an extension would change which file a repository reports as its entry point.
 */
const ENTRY_POINT_EXTENSIONS: readonly string[] = [
  "ts", "tsx", "mts", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb", "java", "kt",
  "swift", "cs", "php",
];

/**
 * Framework layouts whose entry point is not a `index`/`main` file at all. Kept as
 * literals because there is no pattern to generate — these are specific filenames that
 * specific frameworks give specific meaning.
 */
const FRAMEWORK_ENTRY_POINTS: readonly string[] = [
  "app/page.tsx",
  "app/layout.tsx",
  "pages/index.tsx",
  "cmd/main.go",
  "manage.py",
];

/** Every candidate, in detection order. Computed once — the cross product is fixed. */
const ENTRY_POINTS: readonly string[] = (() => {
  const out: string[] = [];
  for (const dir of ENTRY_POINT_DIRECTORIES) {
    for (const base of ENTRY_POINT_BASENAMES) {
      for (const ext of ENTRY_POINT_EXTENSIONS) {
        out.push(dir === "" ? `${base}.${ext}` : `${dir}/${base}.${ext}`);
      }
    }
  }
  return [...out, ...FRAMEWORK_ENTRY_POINTS];
})();

/**
 * Entry points present in a repository, in detection order.
 *
 * Exported so query-time selection can re-run detection against an index built before
 * this widening existed. Re-ingesting every repository to pick up a better list is not
 * something a user should have to know to do.
 */
export function detectEntryPoints(paths: ReadonlySet<string>): string[] {
  return ENTRY_POINTS.filter((candidate) => paths.has(candidate));
}

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
  /**
   * Files whose import scan aborted or was truncated.
   *
   * Their edges were kept, so this is not a count of lost data — it is a count of files
   * whose edge list is a floor rather than a total. Optional because a snapshot indexed
   * before the scanner reported confidence cannot say, and "cannot say" is not zero.
   */
  filesWithIncompleteImportScan?: number;
}

/**
 * Everything this index cannot do, as data rather than as a sentence.
 *
 * WHY THIS REPLACED STRING CONCATENATION
 * The note started as one sentence about unsupported languages. It then grew an import
 * clause, an entry-point clause and an incomplete-scan clause, each appended by a
 * helper interpolated into the return value — and there were TWO return paths, so a new
 * clause had to be remembered in both. One already had not been: the branch for a
 * repository with no symbols at all appended the entry-point note but not the import
 * note, so a Python repository built by an older extractor reported neither fact. That
 * is the failure this shape prevents, not a hypothetical.
 *
 * A fifth limitation is now one entry in the list below, visible to every caller, with
 * no return path to keep in step.
 */
export type CoverageLimitationCode =
  | "symbols-unsupported"
  | "symbols-partial"
  | "imports-pre-feature"
  | "imports-not-parsed"
  | "imports-incomplete"
  | "no-entry-point"
  | "stale-extractor";

export interface CoverageLimitation {
  code: CoverageLimitationCode;
  /** One sentence, safe to show a user. */
  message: string;
}

/** Extra facts the caller holds that are not part of IndexCoverage itself. */
export interface CoverageContext {
  /** How many entry points detection found. Undefined means "not supplied". */
  entryPointCount?: number;
  /** Stored derivation version. Undefined means "not supplied"; null means unknown. */
  derivationVersion?: number | null;
  /** Current derivation version, for comparison. */
  currentDerivationVersion?: number;
}

/**
 * Every limitation of this index, in reporting order.
 *
 * Returns an empty array for a fully covered index. Exported so a caller that wants to
 * act on a specific limitation — rather than print all of them — can, which is what a
 * string could never support.
 */
export function coverageLimitations(
  coverage: IndexCoverage | undefined,
  context: CoverageContext = {}
): CoverageLimitation[] {
  if (!coverage) return [];

  const out: CoverageLimitation[] = [];
  const file = (n: number): string => `${n.toLocaleString("en-US")} file${n === 1 ? "" : "s"}`;
  const { indexedFiles, symbolEligibleFiles, filesWithSymbols, languagesWithoutSymbols } = coverage;
  const withoutSymbols = indexedFiles - filesWithSymbols;

  // --- symbols ---------------------------------------------------------------
  if (withoutSymbols > 0) {
    if (!coverage.symbolsExtracted || symbolEligibleFiles === 0) {
      const found =
        languagesWithoutSymbols.length > 0
          ? ` Detected: ${languagesWithoutSymbols.join(", ")}.`
          : "";
      out.push({
        code: "symbols-unsupported",
        message:
          `Symbol extraction currently supports ${SYMBOL_LANGUAGE_LABEL} only, so all ` +
          `${file(indexedFiles)} were indexed by path and content only.${found} ` +
          `Answers still work, but questions naming a function or class are matched less precisely.`,
      });
    } else {
      out.push({
        code: "symbols-partial",
        message:
          `Symbol extraction currently supports ${SYMBOL_LANGUAGE_LABEL} only, so ` +
          `${file(withoutSymbols)} were indexed by path and content only.`,
      });
    }
  }

  // --- imports ---------------------------------------------------------------
  if (coverage.importsExtracted === undefined) {
    out.push({
      code: "imports-pre-feature",
      message:
        "This repository was indexed before import extraction existed, so related files" +
        " are not followed along imports. Re-attach it to rebuild the index.",
    });
  } else if (coverage.importsExtracted === false) {
    out.push({
      code: "imports-not-parsed",
      message:
        "Imports were not parsed for this repository, so related files are not followed" +
        " along imports.",
    });
  } else {
    const incomplete = coverage.filesWithIncompleteImportScan ?? 0;
    if (incomplete > 0) {
      out.push({
        code: "imports-incomplete",
        message:
          `Imports could not be fully read in ${file(incomplete)}, so the import graph` +
          ` for ${incomplete === 1 ? "it" : "those"} is incomplete.`,
      });
    }
  }

  // --- entry points ----------------------------------------------------------
  if (context.entryPointCount === 0) {
    out.push({
      code: "no-entry-point",
      message:
        "No entry point was detected for this repository, so questions that name no file" +
        " start from the most-imported files instead of from a known starting point.",
    });
  }

  // --- extractor version -----------------------------------------------------
  // Reported LAST because it subsumes the others: everything above describes what this
  // index can do, and this says the index was built by code that has since improved.
  if (
    typeof context.currentDerivationVersion === "number" &&
    context.derivationVersion !== undefined &&
    !(
      typeof context.derivationVersion === "number" &&
      context.derivationVersion >= context.currentDerivationVersion
    )
  ) {
    out.push({
      code: "stale-extractor",
      message:
        "This index was built by an older version of the code that reads imports and" +
        " symbols, so some of its results are out of date. Re-attaching the repository" +
        " rebuilds it.",
    });
  }

  return out;
}

/**
 * Coverage as one paragraph, or null when there is nothing worth saying.
 *
 * Null on a fully covered index: a message that always appears is noise, and a user
 * whose JavaScript repo indexed completely does not need telling that JavaScript is
 * supported. It speaks up only where expectations would otherwise be wrong.
 *
 * Built here rather than in the route so the API response and any UI say the same
 * thing. The numbers are counts, not adjectives — "312 files were indexed by path and
 * content only" is checkable; "partial coverage" is not.
 */
export function describeCoverage(
  coverage: IndexCoverage | undefined,
  context: CoverageContext = {}
): string | null {
  const limitations = coverageLimitations(coverage, context);
  if (limitations.length === 0 || !coverage) return null;

  const file = (n: number): string => `${n.toLocaleString("en-US")} file${n === 1 ? "" : "s"}`;
  return [`Indexed ${file(coverage.indexedFiles)}.`, ...limitations.map((l) => l.message)].join(" ");
}

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

  const entryPoints = detectEntryPoints(paths);

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
