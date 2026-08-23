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
}

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
