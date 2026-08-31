import {
  extractImports,
  parseTsconfigAliases,
  resolveImport,
  supportsImports,
  type AliasConfig,
} from "@/lib/repo/imports";
import type { NormalizedArtifact } from "./types";

/**
 * Static verification of a generated project, between validation and persistence.
 *
 * WHAT THIS IS FOR
 * lib/artifacts/validate.ts asks "is this output safe and complete-looking?" — paths,
 * secrets, sizes, truncation. Every one of those questions is about a file in
 * isolation. This module asks the question no single file can answer: do these files
 * make a project? A model reliably emits fifty individually well-formed files that
 * import a `./lib/db` it never wrote, and validation passes all fifty.
 *
 * IN MEMORY, AND ONLY IN MEMORY
 * No filesystem, no child process, no container, no network. Everything here reads the
 * `NormalizedArtifact` the parser already produced. That is a hard constraint, not a
 * simplification: this runs inside a request on a 512MB instance, and any of those
 * would either not exist there or would take the request down with them.
 *
 * DETECTION ONLY
 * Nothing here repairs, retries, or re-prompts. The report is the deliverable, shaped
 * as data so model routing and escalation can consume it later without parsing prose.
 *
 * WHAT IT CANNOT DO, stated because a verifier that overstates its reach is worse than
 * none: it does not compile, type-check, execute, or resolve anything through
 * node_modules. A project that passes every check here can still fail to build.
 * "Verified" below means exactly the checks named in the report, and a check that did
 * not run says `skipped` rather than `passed`.
 */

/** Stable identifiers. Persisted in reports, so renaming one is a data migration. */
export type CheckName =
  | "imports-resolve"
  | "manifest-coherence"
  | "required-files"
  | "structural-sanity";

/**
 * `skipped` is load-bearing. A non-JavaScript project has no manifest to be coherent
 * with, and recording that as `passed` would let a later reader — or an escalation
 * policy reading these rows — treat "not applicable" as evidence of correctness. It is
 * the same distinction Repository.symbolsExtracted draws for the repository index.
 */
export type CheckStatus = "passed" | "failed" | "skipped";

/** Machine-readable finding subtypes. Kept narrow so routing can switch on them. */
export type FindingCode =
  | "unresolved-internal-import"
  | "missing-dependency"
  | "unused-dependency"
  | "package-json-invalid"
  | "prisma-schema-missing"
  | "next-entry-missing"
  | "empty-file"
  | "fence-only-file"
  | "duplicate-path";

export interface VerificationFinding {
  check: CheckName;
  code: FindingCode;
  /** Artifact-relative path the problem lives in, or null when it is project-wide. */
  file: string | null;
  /** One concrete sentence. Safe to show a user: it names only generated content. */
  message: string;
  /**
   * Structured particulars — the specifier, the package name. Present so a consumer
   * can act on a finding without re-parsing `message`, which is the whole reason this
   * is a data structure and not a log line.
   */
  detail?: Record<string, string>;
}

export interface CheckOutcome {
  check: CheckName;
  status: CheckStatus;
  /** Why it did not run. Null when it ran. Never set on a check that ran. */
  skippedReason: string | null;
  errorCount: number;
  warningCount: number;
}

export interface VerificationReport {
  /** False when any error was found. Warnings never affect this. */
  ok: boolean;
  errors: VerificationFinding[];
  warnings: VerificationFinding[];
  /** One entry per check, including the ones that did not run. */
  checks: CheckOutcome[];
  /**
   * Schema version of this report. Stored rows outlive the code that wrote them, and a
   * consumer reading a two-year-old report needs to know which shape it is looking at.
   */
  version: 1;
}

/** Node builtins, which are dependencies of nothing and must never be reported missing. */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

/**
 * Package name from a specifier: `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`.
 * Returns null for a builtin, which is not a dependency anyone declares.
 */
function packageNameOf(specifier: string): string | null {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (NODE_BUILTINS.has(bare)) return null;

  const parts = bare.split("/");
  if (bare.startsWith("@")) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  const name = parts[0];
  return name.length > 0 ? name : null;
}

/**
 * Extensions whose imports are read. Narrower than the file set on purpose: only
 * languages lib/repo/imports.ts actually parses contribute findings, so a Python file
 * in a mixed project is never reported as having unresolvable imports it was never
 * scanned for.
 */
function languageOf(path: string): string | null {
  if (/\.(ts|tsx|mts|cts)$/i.test(path)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return "javascript";
  return null;
}

/** A file whose entire content is a markdown fence, with nothing real inside it. */
function isFenceOnly(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return false;
  // Strip the opening fence line and any closing fence, then see if anything is left.
  const withoutFences = trimmed
    .replace(/^```[^\n]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  return withoutFences.length === 0;
}

interface Collector {
  errors: VerificationFinding[];
  warnings: VerificationFinding[];
}

function outcome(
  check: CheckName,
  before: Collector,
  after: Collector,
  skippedReason?: string
): CheckOutcome {
  if (skippedReason) {
    return { check, status: "skipped", skippedReason, errorCount: 0, warningCount: 0 };
  }
  const errorCount = after.errors.length - before.errors.length;
  const warningCount = after.warnings.length - before.warnings.length;
  return {
    check,
    status: errorCount > 0 ? "failed" : "passed",
    skippedReason: null,
    errorCount,
    warningCount,
  };
}

/** A report where every check is recorded as not having run, with the reason. */
function allSkipped(reason: string): VerificationReport {
  const names: CheckName[] = [
    "imports-resolve",
    "manifest-coherence",
    "required-files",
    "structural-sanity",
  ];
  return {
    ok: true,
    errors: [],
    warnings: [],
    checks: names.map((check) => ({
      check,
      status: "skipped" as const,
      skippedReason: reason,
      errorCount: 0,
      warningCount: 0,
    })),
    version: 1,
  };
}

/**
 * Run every static check against a validated artifact.
 *
 * Only multi-file project archives are verified. A `pdf` has no files, and a single
 * `file` artifact has nothing to be internally consistent WITH — its imports resolve
 * to a project that was never part of the request, so reporting them as unresolved
 * would be a lie about what the user asked for. Both return an all-skipped report
 * rather than an empty passing one.
 */
export function verifyArtifact(artifact: NormalizedArtifact): VerificationReport {
  if (artifact.type !== "zip") {
    return allSkipped(`artifact type "${artifact.type}" is not a multi-file project`);
  }
  if (artifact.files.length === 0) {
    return allSkipped("artifact contains no files");
  }

  const collector: Collector = { errors: [], warnings: [] };
  const checks: CheckOutcome[] = [];

  const snapshot = (): Collector => ({
    errors: [...collector.errors],
    warnings: [...collector.warnings],
  });

  const paths = new Set(artifact.files.map((f) => f.path));
  const byPath = new Map(artifact.files.map((f) => [f.path, f.content]));

  // Aliases the generated project declares for itself. Read from the artifact, never
  // from this repository's tsconfig — the project being verified defines its own.
  const tsconfig = byPath.get("tsconfig.json");
  const aliases: AliasConfig | null = tsconfig ? parseTsconfigAliases(tsconfig) : null;

  // -------------------------------------------------------------------------
  // Completeness: every relative import names a file that was actually generated
  // -------------------------------------------------------------------------
  let before = snapshot();
  const externalSpecifiers = new Map<string, string>(); // package -> first importing file
  const scannable = artifact.files.filter((f) => supportsImports(languageOf(f.path)));

  for (const file of scannable) {
    for (const specifier of extractImports(file.content)) {
      const resolution = resolveImport(file.path, specifier, paths, aliases);

      if (resolution.kind === "resolved") continue;

      if (resolution.kind === "external") {
        const pkg = packageNameOf(specifier);
        if (pkg && !externalSpecifiers.has(pkg)) externalSpecifiers.set(pkg, file.path);
        continue;
      }

      // `unresolved` means the specifier LOOKED like it named a file in this project —
      // relative, or matching the project's own tsconfig alias — and no such file was
      // generated. That is the single most common way a generated project is broken
      // while every individual file looks complete.
      collector.errors.push({
        check: "imports-resolve",
        code: "unresolved-internal-import",
        file: file.path,
        message: `"${file.path}" imports "${specifier}", which no generated file provides`,
        detail: { specifier },
      });
    }
  }

  checks.push(
    outcome(
      "imports-resolve",
      before,
      collector,
      scannable.length === 0 ? "no JavaScript or TypeScript files to scan" : undefined
    )
  );

  // -------------------------------------------------------------------------
  // Manifest coherence
  // -------------------------------------------------------------------------
  before = snapshot();
  const manifestSource = byPath.get("package.json");
  let manifest: { dependencies?: unknown; devDependencies?: unknown } | null = null;
  let manifestInvalid = false;

  if (manifestSource !== undefined) {
    try {
      manifest = JSON.parse(manifestSource) as typeof manifest;
      if (typeof manifest !== "object" || manifest === null) {
        manifest = null;
        manifestInvalid = true;
      }
    } catch {
      manifestInvalid = true;
    }
  }

  const declared = new Set<string>();
  if (manifest) {
    for (const field of ["dependencies", "devDependencies"] as const) {
      const block = manifest[field];
      if (block && typeof block === "object") {
        for (const name of Object.keys(block as Record<string, unknown>)) declared.add(name);
      }
    }
  }

  if (manifest) {
    for (const [pkg, importer] of Array.from(externalSpecifiers)) {
      if (declared.has(pkg)) continue;
      collector.errors.push({
        check: "manifest-coherence",
        code: "missing-dependency",
        file: importer,
        message: `"${importer}" imports "${pkg}", which package.json does not declare`,
        detail: { package: pkg },
      });
    }

    for (const name of Array.from(declared).sort()) {
      if (externalSpecifiers.has(name)) continue;
      // A WARNING, not an error. Plenty of real dependencies are never imported by
      // name — CLI tools, framework plugins, type packages, anything invoked through a
      // script — so blocking on this would reject correct projects.
      collector.warnings.push({
        check: "manifest-coherence",
        code: "unused-dependency",
        file: "package.json",
        message: `package.json declares "${name}", which no generated file imports`,
        detail: { package: name },
      });
    }
  }

  checks.push(
    outcome(
      "manifest-coherence",
      before,
      collector,
      manifestSource === undefined
        ? "the project has no package.json"
        : manifestInvalid
          ? "package.json could not be parsed"
          : undefined
    )
  );

  // -------------------------------------------------------------------------
  // Required files
  // -------------------------------------------------------------------------
  before = snapshot();

  if (manifestInvalid) {
    collector.errors.push({
      check: "required-files",
      code: "package-json-invalid",
      file: "package.json",
      message: "package.json is not valid JSON, so the project cannot be installed",
    });
  }

  // Prisma is detected from the manifest rather than from a path, so a project that
  // depends on it but forgot the schema entirely is still caught — which is the case
  // worth catching.
  const usesPrisma =
    declared.has("prisma") ||
    declared.has("@prisma/client") ||
    artifact.files.some((f) => f.path.startsWith("prisma/"));
  if (usesPrisma && !paths.has("prisma/schema.prisma")) {
    collector.errors.push({
      check: "required-files",
      code: "prisma-schema-missing",
      file: null,
      message: "the project uses Prisma but no prisma/schema.prisma was generated",
    });
  }

  const usesNext = declared.has("next");
  if (usesNext) {
    const hasEntry = artifact.files.some(
      (f) => f.path.startsWith("app/") || f.path.startsWith("pages/")
    );
    if (!hasEntry) {
      collector.errors.push({
        check: "required-files",
        code: "next-entry-missing",
        file: null,
        message: "the project uses Next.js but has no app/ or pages/ directory to route from",
      });
    }
  }

  checks.push(outcome("required-files", before, collector));

  // -------------------------------------------------------------------------
  // Structural sanity
  //
  // DELIBERATELY REDUNDANT with lib/artifacts/validate.ts, which already rejects empty
  // files and duplicate paths before this module is reached. Kept for the same reason
  // isSelectableSource is re-checked in lib/repo/selection.ts: those guards live on a
  // different call path, and a refactor that moved or weakened one of them would
  // otherwise let malformed files through with nothing re-checking. The fence-only
  // case is genuinely new — a file containing nothing but ``` is non-empty, has an even
  // fence count, and passes every existing check.
  // -------------------------------------------------------------------------
  before = snapshot();
  const seen = new Set<string>();

  for (const file of artifact.files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      collector.errors.push({
        check: "structural-sanity",
        code: "duplicate-path",
        file: file.path,
        message: `"${file.path}" appears more than once in the project`,
      });
    }
    seen.add(key);

    if (file.content.trim().length === 0) {
      collector.errors.push({
        check: "structural-sanity",
        code: "empty-file",
        file: file.path,
        message: `"${file.path}" is empty`,
      });
      continue;
    }

    if (isFenceOnly(file.content)) {
      collector.errors.push({
        check: "structural-sanity",
        code: "fence-only-file",
        file: file.path,
        message: `"${file.path}" contains only a Markdown code fence and no code`,
      });
    }
  }

  checks.push(outcome("structural-sanity", before, collector));

  return {
    ok: collector.errors.length === 0,
    errors: collector.errors,
    warnings: collector.warnings,
    checks,
    version: 1,
  };
}

/**
 * One-line-per-finding summary for the user, or null when there is nothing to say.
 *
 * Warnings must reach the person who asked for the project. They do not block the
 * download, and a warning that only ever appears in a server log is indistinguishable
 * from one that was never raised.
 */
export function describeWarnings(report: VerificationReport, limit = 4): string | null {
  if (report.warnings.length === 0) return null;

  const shown = report.warnings.slice(0, limit).map((w) => `- ${w.message}`);
  const rest = report.warnings.length - shown.length;
  if (rest > 0) shown.push(`- and ${rest} more`);

  return [
    `Note: ${report.warnings.length} thing${report.warnings.length === 1 ? "" : "s"} worth checking, none of which block the download:`,
    ...shown,
  ].join("\n");
}
