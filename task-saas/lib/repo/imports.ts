import { maskNonCode } from "./mask-code";
/**
 * Import/require extraction and resolution, for JavaScript and TypeScript.
 *
 * WHY REGEX AND NOT A PARSER
 * The same posture, and the same reasoning, as lib/repo/symbols.ts: the cheap
 * structural approach first, a real parser only once it demonstrably fails. The blind
 * spots are listed below so the failure is recognised when it arrives rather than
 * rediscovered — and, as there, a specifier found inside a comment or a string literal
 * produces a FALSE POSITIVE rather than a miss.
 *
 * WHAT "RESOLVED" MEANS HERE
 * Only ever "this specifier names another file in THIS repository snapshot". Nothing
 * is fetched, nothing on disk is consulted, and node_modules is not read — resolution
 * is a lookup against the set of paths the tree API already returned. A specifier that
 * cannot be matched that way is recorded with its raw text and a reason, never dropped:
 * an edge list that silently omits what it could not understand is indistinguishable
 * from one where those imports do not exist, which is the same failure class as a file
 * with no symbols recorded looking like a file that exports nothing.
 *
 * KNOWN BLIND SPOTS, none of which throw:
 *   - specifiers built at runtime (`require(base + name)`) — not a literal, not seen
 *   - imports inside comments or strings — false positives, as in symbols.ts
 *   - nested tsconfig files in a monorepo; only the ROOT tsconfig's paths are read
 *   - `export =` / triple-slash `/// <reference>` directives
 *   - conditional exports and the "imports" field of package.json (`#internal`)
 */

/**
 * Languages whose imports this module understands.
 *
 * Deliberately a SEPARATE constant from SYMBOL_LANGUAGES even though the two currently
 * hold the same values. They answer different questions — "can this file's exports be
 * read" and "can this file's imports be read" — and a future extractor will almost
 * certainly cover one before the other. Aliasing them now would make that divergence a
 * refactor instead of an edit, and in the meantime would let coverage report a language
 * as import-covered on the strength of its symbol support.
 */
export const IMPORT_LANGUAGES: readonly string[] = ["javascript", "typescript"];

/** True for languages whose imports this module understands. */
export function supportsImports(language: string | null): boolean {
  return language !== null && IMPORT_LANGUAGES.includes(language);
}

/**
 * Bound so a generated or bundled file cannot contribute thousands of edges. A file
 * with more imports than this is not one a reader navigates by import graph anyway.
 */
const MAX_IMPORTS_PER_FILE = 200;

/**
 * Extraction patterns. Line-anchored where the syntax is a statement, so that prose
 * mentioning the word "import" mid-sentence does not match.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from "m" / import { a } from "m" / import type { A } from "m"
  //
  // This also covers the multi-line list a formatter produces, because
  // `[^'"]*?` is a negated class and therefore spans newlines — the only thing it
  // cannot cross is the quote ending the specifier. A dedicated pattern anchored on
  // the closing brace was written for that case and then deleted: mutation testing
  // showed removing it changed no result, because this pattern had been doing the
  // work all along. The multi-line extraction test is what pins that behaviour.
  /^\s*import\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  // import "m" — side-effect only, no binding
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  // export { a } from "m" / export * from "m" / export type { A } from "m"
  /^\s*export\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  // require("m") — anywhere, since it is an expression rather than a statement
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // dynamic import("m") — likewise an expression
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * How completely a file's imports could be read.
 *
 * SEPARATE FROM LANGUAGE SUPPORT, deliberately. "This scanner does not read Python"
 * and "this TypeScript file's scan broke" are different facts with opposite correct
 * responses, and a single boolean would force callers to treat them alike. Language
 * support is a precondition the CALLER checks with `supportsImports`; this describes
 * what happened once scanning actually started.
 */
export type ImportScanStatus =
  /** Every pattern ran to the end of the file. The specifier list is exhaustive. */
  | "complete"
  /** A pattern threw. Whatever is in the list was found before that; the rest is unknown. */
  | "aborted"
  /** The per-file cap was reached, so imports past that point were never looked at. */
  | "truncated";

export interface ImportScan {
  /** Specifiers found, deduplicated and order-stable. */
  specifiers: string[];
  status: ImportScanStatus;
  /**
   * Import-like constructs whose target is not a string literal — `require(base + name)`
   * and its dynamic-import equivalent.
   *
   * A REAL COUNT, not an estimate: it counts `require(` and `import(` occurrences whose
   * first argument does not open with a quote. Those are legal, reasonably common, and
   * unreadable by any amount of regex, so a caller that needs certainty has to know
   * they were there. Everything else this scanner misses it misses silently, and this
   * number does not pretend otherwise.
   */
  unread: number;
}

/** `require(` / `import(` whose first argument is not a quoted literal. */
const DYNAMIC_TARGET_PATTERNS: readonly RegExp[] = [
  /\brequire\s*\(\s*(?!['"])/g,
  /\bimport\s*\(\s*(?!['"])/g,
];

/**
 * Scan a file for import specifiers, reporting how complete the scan was.
 *
 * WHY THIS RETURNS CONFIDENCE AND NOT JUST A LIST
 * It used to return a bare array, and a partial result was indistinguishable from a
 * complete one. That is harmless on the ingestion path — fewer edges, a weaker graph —
 * and dangerous on the verification path, where fewer specifiers means fewer
 * unresolved-import errors, so an artifact could pass because its imports were NOT READ
 * rather than because they resolved. Same function, opposite risk, and no way for
 * either caller to tell which it had.
 *
 * Never throws. A file that cannot be scanned reports `aborted` with whatever was found
 * before the failure, because one pathological file must not fail an entire ingestion —
 * but it says so, which is the part that was missing.
 */
export function scanImports(source: string): ImportScan {
  const found: string[] = [];
  const seen = new Set<string>();
  let status: ImportScanStatus = "complete";

  /**
   * Patterns run against a copy with comments and literal interiors blanked out, and
   * specifiers are then read from the ORIGINAL at the same offsets.
   *
   * Matching on the masked copy is what stops a commented-out require from becoming a
   * specifier; reading from the original is what stops the specifier being filler. The
   * masker preserves length exactly, so the two agree position for position — and so
   * the truncation cap and the unread count below still see a file of the same shape.
   */
  const masked = maskNonCode(source);

  try {
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(masked)) !== null) {
        /**
         * Recover the specifier from the ORIGINAL source at the same offsets.
         *
         * The `d` flag would give the group's position directly, but it needs an ES2022
         * target this project does not use — the same ceiling that rules out bigint
         * literals. The arithmetic below is equivalent here: the captured group is a run
         * of mask filler, and the surrounding pattern cannot contain a second literal
         * (`[^'"]*?` cannot cross a quote), so its first occurrence inside the match is
         * unambiguous.
         */
        const captured = match[1] ?? "";
        const relative = match[0].indexOf(captured);
        const specifier =
          relative >= 0
            ? source.slice(match.index + relative, match.index + relative + captured.length).trim()
            : captured.trim();
        if (!specifier || seen.has(specifier)) continue;
        seen.add(specifier);
        found.push(specifier);
        if (found.length >= MAX_IMPORTS_PER_FILE) {
          // Not "complete with a lot of imports": the rest of the file was never read,
          // and a caller deciding whether every import resolves must know that.
          return { specifiers: found, status: "truncated", unread: countUnread(masked) };
        }
      }
    }
  } catch {
    /**
     * DEFENSIVE, and unreachable from any input as these patterns stand: `exec` does not
     * throw on a string, so nothing here can currently produce `aborted`.
     *
     * Recorded as measured rather than assumed — a mutation that reported this state as
     * `complete` did not fail a single test, which is the signature of unreachable code
     * rather than of a weak test. It stays because the alternative is that the day a
     * pattern DOES throw, an ingestion is lost instead of degraded, and because
     * verification's response to the state is tested by injection.
     */
    status = "aborted";
  }

  return { specifiers: found, status, unread: countUnread(masked) };
}

/** Import-like constructs with a non-literal target. Never throws. */
function countUnread(source: string): number {
  let total = 0;
  try {
    for (const pattern of DYNAMIC_TARGET_PATTERNS) {
      pattern.lastIndex = 0;
      while (pattern.exec(source) !== null) total++;
    }
  } catch {
    return total;
  }
  return total;
}

/** tsconfig `compilerOptions` fields that affect resolution, and nothing else. */
export interface AliasConfig {
  /** Directory that non-relative alias targets are resolved against, repo-relative. */
  baseUrl: string;
  /** Raw `paths` map, patterns and targets exactly as written. */
  paths: Record<string, string[]>;
}

/**
 * Strip comments and trailing commas so `JSON.parse` can read a tsconfig.
 *
 * tsconfig.json is JSONC in practice — TypeScript accepts comments, and real projects
 * use them. A strict parse fails on the majority of real tsconfigs, and failing means
 * silently losing every aliased edge in the repository, so tolerating the dialect is
 * doing the job rather than being lenient for its own sake.
 *
 * String-aware: a `//` inside a path value is not a comment, and treating it as one
 * would corrupt exactly the field being read.
 */
function stripJsonc(source: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      // A backslash escapes the next character, including a quote.
      if (c === "\\") {
        out += source[i + 1] ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  // Trailing commas before } or ], which TypeScript also accepts.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Read `compilerOptions.baseUrl` and `.paths` from a root tsconfig.
 *
 * Returns null when there is nothing usable — no tsconfig, unreadable, or no `paths`.
 * Null and "an empty alias map" are deliberately the same thing to callers: both mean
 * no specifier can resolve by alias, and coverage records which of the two it was.
 */
export function parseTsconfigAliases(source: string): AliasConfig | null {
  try {
    const parsed = JSON.parse(stripJsonc(source)) as {
      compilerOptions?: { baseUrl?: unknown; paths?: unknown };
    };
    const options = parsed?.compilerOptions;
    if (!options || typeof options !== "object") return null;

    const rawPaths = options.paths;
    if (!rawPaths || typeof rawPaths !== "object") return null;

    const paths: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const usable = targets.filter((t): t is string => typeof t === "string");
      if (usable.length > 0) paths[pattern] = usable;
    }
    if (Object.keys(paths).length === 0) return null;

    // Since TypeScript 4.4 `paths` is legal without `baseUrl`, resolved against the
    // tsconfig's own directory. Only the ROOT tsconfig is read, so that is the repo
    // root, and "." is the correct default rather than a guess.
    const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
    return { baseUrl, paths };
  } catch {
    return null;
  }
}

/** How a specifier related to this repository, and why. */
export type Resolution =
  /** Names a file in this snapshot. `path` is that file's repo-relative path. */
  | { kind: "resolved"; path: string }
  /** A bare specifier: a published package, or a builtin. Nothing to point at. */
  | { kind: "external" }
  /**
   * Looked like it should name a file here — relative, or matched an alias — and did
   * not. A real signal: usually a file excluded from the index, or an alias this module
   * resolved differently from the bundler.
   */
  | { kind: "unresolved" };

/**
 * Extensions tried for an extension-less specifier, in TypeScript's own preference
 * order. `.d.ts` sits after `.ts` deliberately: when both exist the implementation is
 * the file a reader wants, not the declaration.
 */
const RESOLVE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Rewrites applied when a specifier carries a JS extension but the source is TS. */
const JS_TO_TS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

/** Collapse `.` and `..` in a POSIX path. Returns null if it escapes the repo root. */
function normalisePosix(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Escaping the root means the specifier points outside the snapshot entirely.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** Directory of a repo-relative file path, "" at the root. */
function dirnamePosix(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Every path a single candidate could mean, in the order TypeScript would try them:
 * the exact file, then extensions, then a directory index.
 */
function candidatesFor(base: string): string[] {
  const out = [base];

  for (const [from, replacements] of JS_TO_TS) {
    if (base.endsWith(from)) {
      const stem = base.slice(0, -from.length);
      // "./foo.js" meaning foo.ts is not an edge case but the documented way to write
      // relative imports in a TypeScript ESM package. Missing it would drop every
      // internal edge in any repository that follows that guidance.
      for (const to of replacements) out.push(`${stem}${to}`);
    }
  }

  for (const ext of RESOLVE_EXTENSIONS) out.push(`${base}${ext}`);
  for (const ext of RESOLVE_EXTENSIONS) out.push(`${base}/index${ext}`);

  return out;
}

/** Apply a tsconfig `paths` pattern, returning the substituted targets. */
function applyAlias(specifier: string, aliases: AliasConfig): string[] | null {
  const base = normalisePosix(aliases.baseUrl) ?? "";
  const prefix = base === "" ? "" : `${base}/`;
  const out: string[] = [];

  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const star = pattern.indexOf("*");

    if (star === -1) {
      if (specifier !== pattern) continue;
      for (const target of targets) out.push(`${prefix}${target}`);
      continue;
    }

    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (!specifier.startsWith(head) || !specifier.endsWith(tail)) continue;
    if (specifier.length < head.length + tail.length) continue;

    const matched = specifier.slice(head.length, specifier.length - tail.length);
    for (const target of targets) out.push(`${prefix}${target.replace("*", matched)}`);
  }

  return out.length > 0 ? out : null;
}

/**
 * Resolve one import specifier against the files in this repository snapshot.
 *
 * `files` is the set of every indexed path — the same list the tree API returned — so
 * resolution is a membership test and costs nothing per candidate.
 *
 * A SELF-IMPORT RESOLVES TO ITSELF and is reported as such. It is a real, if unusual,
 * fact about the file; deciding here that it is uninteresting would hide it from a
 * caller who might reasonably want to flag it. Whether to persist a self-edge is the
 * ingest layer's decision, not the resolver's.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  files: ReadonlySet<string>,
  aliases: AliasConfig | null
): Resolution {
  if (specifier.length === 0) return { kind: "unresolved" };

  const firstMatch = (bases: readonly string[]): string | null => {
    for (const base of bases) {
      const normalised = normalisePosix(base);
      if (normalised === null) continue;
      for (const candidate of candidatesFor(normalised)) {
        if (files.has(candidate)) return candidate;
      }
    }
    return null;
  };

  // Relative. The only form that is unambiguously about this repository, so a miss
  // here is "unresolved" and never "external".
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const joined = `${dirnamePosix(fromPath)}/${specifier}`;
    const hit = firstMatch([joined]);
    return hit ? { kind: "resolved", path: hit } : { kind: "unresolved" };
  }

  // Alias. Matching a pattern is a claim that this names something in the repo, so a
  // miss is likewise "unresolved" rather than a package.
  if (aliases) {
    const substituted = applyAlias(specifier, aliases);
    if (substituted) {
      const hit = firstMatch(substituted);
      return hit ? { kind: "resolved", path: hit } : { kind: "unresolved" };
    }
  }

  // Anything else is a bare specifier: a package, a node builtin, or a subpath import.
  // Not a failure to resolve — there is genuinely no file here for it to name.
  return { kind: "external" };
}
