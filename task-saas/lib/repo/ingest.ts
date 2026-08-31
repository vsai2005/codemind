import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  fetchRepoMeta,
  fetchTarball,
  fetchTree,
  ingestDeadline,
  GitHubError,
  isGitHubConfigured,
  type RepoRef,
} from "@/lib/repo/github";
import { readTarball } from "@/lib/repo/archive";
import { extractInternalSymbols, extractSymbols, supportsSymbols } from "@/lib/repo/symbols";
import {
  scanImports,
  parseTsconfigAliases,
  resolveImport,
  supportsImports,
  type AliasConfig,
} from "@/lib/repo/imports";
import {
  detectStructure,
  languageForPath,
  primaryLanguage,
  type IndexCoverage,
} from "@/lib/repo/structure";

/**
 * Build the index for one public repository snapshot.
 *
 * Two GitHub requests total: one to resolve the default branch and its head commit,
 * one to fetch the entire file tree recursively. Contents are never fetched here —
 * this produces the LIST that query-time selection reads, and only the handful of
 * files a question needs are ever downloaded.
 *
 * WALKING SKELETON. This runs to completion inside one request, which is honest only
 * because it is two API calls regardless of repository size. The import graph, sliced
 * resumable ingestion and rate-limit pausing are deliberately absent: the pipeline is
 * proven end to end first, then made robust. What is NOT deferred is truncation
 * detection, because a silently partial index is the one failure that looks like
 * success.
 */

/**
 * Ceiling on indexed files.
 *
 * Not an API-budget limit — the tree costs one request at any size. This bounds the
 * database write and the row count per repository, and it is the point where a repo is
 * large enough that file-path selection alone stops being good enough to find the right
 * file. Crossing it is reported, never silently truncated.
 */
export const MAX_INDEXED_FILES = 4000;

export type IngestResult =
  | {
      ok: true;
      repositoryId: string;
      fileCount: number;
      reused: boolean;
      /**
       * What the caller can honestly tell the user about this index. Absent on a
       * reused snapshot indexed before coverage was recorded — see the read below.
       */
      coverage?: IndexCoverage;
    }
  | { ok: false; error: string };

/**
 * Index `ref`, or return the existing index for the same commit.
 *
 * Idempotent by commit sha: re-running against an unchanged repository finds the ready
 * snapshot and returns it without spending the tree request. A snapshot left in a
 * non-ready state by an interrupted run is rebuilt rather than trusted.
 */
export async function ingestRepository(ref: RepoRef): Promise<IngestResult> {
  const ingestStarted = Date.now();

  /**
   * One budget for the whole ingestion, shared by all four requests.
   *
   * Each request may now retry a transient failure and may wait out an imminent
   * rate-limit reset. Bounded individually that is fine; bounded only individually,
   * four of them compounding is minutes of wall-clock on an operation a user is
   * waiting on. The deadline stops a new attempt from STARTING past it — work already
   * in flight is allowed to finish.
   */
  const deadline = ingestDeadline(ingestStarted);

  if (!isGitHubConfigured()) {
    // 60 requests/hour unauthenticated cannot index anything real, and failing here is
    // clearer than failing partway through with a rate-limit error.
    return {
      ok: false,
      error: "Repository indexing is not configured on this server.",
    };
  }

  let meta;
  try {
    meta = await fetchRepoMeta(ref, { deadline });
  } catch (error) {
    return { ok: false, error: describe(error) };
  }

  const existing = await prisma.repository.findUnique({
    where: {
      owner_name_commitSha: { owner: ref.owner, name: ref.name, commitSha: meta.commitSha },
    },
    select: { id: true, status: true, fileCount: true, structure: true },
  });

  // Only a `ready` snapshot may be reused. Anything else was interrupted, and its rows
  // are a partial list that must not be mistaken for the repository.
  if (existing?.status === "ready") {
    return {
      ok: true,
      repositoryId: existing.id,
      fileCount: existing.fileCount,
      reused: true,
      // Read back rather than recomputed. Without this, re-attaching an already
      // indexed repository would answer with no coverage at all and silently drop the
      // limitation message — the exact silence this change removes. Undefined for a
      // snapshot indexed before coverage was recorded, which is honest: not measured
      // is not the same as measured zero.
      coverage: readCoverage(existing.structure),
    };
  }

  const repository =
    existing ??
    (await prisma.repository.create({
      data: {
        owner: ref.owner,
        name: ref.name,
        defaultBranch: meta.defaultBranch,
        commitSha: meta.commitSha,
        status: "pending",
      },
      select: { id: true, status: true, fileCount: true, structure: true },
    }));

  await prisma.repository.update({
    where: { id: repository.id },
    data: { status: "indexing", error: null },
  });

  try {
    const tree = await fetchTree(ref, meta.commitSha, { deadline });

    /**
     * A truncated tree is a HARD FAILURE, never a warning.
     *
     * GitHub silently returns a partial list when a tree exceeds its response limits.
     * An index built from it has the shape of a complete one — a status of `ready`, a
     * plausible file count, real paths — and every later answer would be confidently
     * wrong about the files it never saw. There is no honest way to answer "does this
     * repo do X" from a list that might be missing X.
     */
    if (tree.truncated) {
      await fail(
        repository.id,
        "This repository is too large to index: GitHub returned only part of its file list."
      );
      logger.warn("Rejected a repository with a truncated tree", {
        owner: ref.owner,
        name: ref.name,
        returnedEntries: tree.entries.length,
      });
      return {
        ok: false,
        error:
          "This repository is too large to index. GitHub only returned part of its file list, and an incomplete index would give wrong answers.",
      };
    }

    if (tree.entries.length > MAX_INDEXED_FILES) {
      await fail(repository.id, `Repository has ${tree.entries.length} files, over the limit.`);
      return {
        ok: false,
        error: `This repository has ${tree.entries.length.toLocaleString()} files, above the ${MAX_INDEXED_FILES.toLocaleString()} currently supported.`,
      };
    }

    const structure = detectStructure(tree.entries);
    const language = primaryLanguage(structure);

    /**
     * Exported symbols, from ONE extra request rather than one per file.
     *
     * Best-effort: a repository that cannot be archived is still perfectly usable
     * indexed by path alone, so a failure here degrades rather than aborts. What must
     * NOT happen is degrading silently — `symbolsExtracted` records whether this
     * actually ran, so selection can never mistake "no symbols recorded" for "this
     * file exports nothing".
     */
    const symbolsByPath = new Map<string, string[]>();
    const internalByPath = new Map<string, string[]>();
    /**
     * Raw import specifiers per file, collected in the SAME pass as symbols.
     *
     * Specifiers are stored raw and resolved after the walk, not during it, because
     * resolution needs the complete file list: `./foo` can only be matched against
     * foo.ts, foo/index.ts and the rest once every path is known. Resolving inline
     * would mean either a second archive read or resolving against a half-built set,
     * and the second is worse — it would silently mark early files unresolved.
     */
    const importsByPath = new Map<string, string[]>();
    /** Root tsconfig contents, captured in the same pass for the same reason. */
    let tsconfigSource: string | null = null;
    /**
     * Files whose import scan did not finish.
     *
     * Their edges are still written; this records that the edge list for them is a
     * floor rather than a total. Without it a file that aborted mid-scan is
     * indistinguishable from one that genuinely imports nothing — the same conflation
     * Repository.symbolsExtracted exists to prevent, one level down.
     */
    const incompleteScans = new Set<string>();
    let symbolsExtracted = false;
    let importsExtracted = false;
    const archiveStarted = Date.now();

    if (language && supportsSymbols(language)) {
      try {
        const stream = await fetchTarball(ref, meta.commitSha, { deadline });
        await readTarball(stream, (entry) => {
          // Captured before the language guard: tsconfig.json is JSON, so it is not a
          // file whose symbols or imports are read, but its `paths` decide how every
          // aliased specifier in the repository resolves.
          if (entry.path === "tsconfig.json") tsconfigSource = entry.content;

          const entryLanguage = languageForPath(entry.path);

          if (supportsSymbols(entryLanguage)) {
            const symbols = extractSymbols(entry.content);
            if (symbols.length > 0) symbolsByPath.set(entry.path, symbols);
            // Internal declarations are what make a file whose meaning lives in private
            // members findable at all — see extractInternalSymbols.
            const internal = extractInternalSymbols(entry.content, symbols);
            if (internal.length > 0) internalByPath.set(entry.path, internal);
          }

          if (supportsImports(entryLanguage)) {
            const scan = scanImports(entry.content);
            // Partial results are KEPT. A scan that aborted still found real imports,
            // and discarding them would trade a known-incomplete graph for an emptier
            // one — worse on both counts. What must not happen is losing the fact that
            // it was incomplete, which is what incompleteScans records.
            if (scan.specifiers.length > 0) importsByPath.set(entry.path, scan.specifiers);
            if (scan.status !== "complete") incompleteScans.add(entry.path);
          }
        });
        symbolsExtracted = true;
        // Set together because they come from the same successful read. Splitting them
        // would claim imports were parsed on a run where the archive never opened.
        importsExtracted = true;
      } catch (error) {
        logger.warn("Symbol extraction failed; indexing by path only", {
          owner: ref.owner,
          name: ref.name,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    const archiveMs = Date.now() - archiveStarted;

    const rows = tree.entries.map((entry) => ({
      repositoryId: repository.id,
      path: entry.path,
      blobSha: entry.blobSha,
      size: entry.size,
      language: languageForPath(entry.path),
      symbols: symbolsByPath.get(entry.path) ?? [],
      internalSymbols: internalByPath.get(entry.path) ?? [],
    }));

    /**
     * Coverage, counted from the rows actually written rather than assumed.
     *
     * Derived here because this is the only place that has both the language of every
     * file and what extraction produced for it. Recomputing it later from the database
     * would be a second implementation of the same arithmetic, free to disagree with
     * this one — and a coverage report that disagrees with the index is worse than
     * none, because it is believed.
     */
    const languagesPresent = Array.from(
      new Set(rows.map((row) => row.language).filter((l): l is string => l !== null))
    ).sort();

    /**
     * Resolve every collected specifier against the complete file list.
     *
     * Now, and not during the walk, because resolution is a membership test against the
     * full set of paths — see importsByPath above. This is pure computation over data
     * already in memory: no request, no second archive read, no file re-opened.
     */
    const aliases: AliasConfig | null = tsconfigSource
      ? parseTsconfigAliases(tsconfigSource)
      : null;
    const pathSet = new Set(rows.map((row) => row.path));

    /** One entry per (source path, specifier). Target path is null when not resolved. */
    const edges: Array<{
      sourcePath: string;
      specifier: string;
      targetPath: string | null;
      kind: "resolved" | "external" | "unresolved";
    }> = [];

    // Array.from because the compile target predates Map iteration — same constraint
    // the rest of this file already works within.
    for (const [sourcePath, specifiers] of Array.from(importsByPath)) {
      // A file that was in the archive but not in the tree cannot be an edge source:
      // there is no row to hang the edge on. Rare, but it is a foreign key that would
      // otherwise fail the whole transaction.
      if (!pathSet.has(sourcePath)) continue;

      for (const specifier of specifiers) {
        const resolution = resolveImport(sourcePath, specifier, pathSet, aliases);
        edges.push({
          sourcePath,
          specifier,
          targetPath: resolution.kind === "resolved" ? resolution.path : null,
          kind: resolution.kind,
        });
      }
    }

    const coverage = {
      indexedFiles: rows.length,
      symbolEligibleFiles: rows.filter((row) => supportsSymbols(row.language)).length,
      filesWithSymbols: rows.filter(
        (row) => row.symbols.length > 0 || row.internalSymbols.length > 0
      ).length,
      languages: languagesPresent,
      languagesWithoutSymbols: languagesPresent.filter((l) => !supportsSymbols(l)),
      symbolsExtracted,

      // Import coverage, counted from what was actually produced. Reported even when
      // every number is zero, because "parsed and found none" and "never parsed" are
      // different facts and only importsExtracted tells them apart.
      importsExtracted,
      importEligibleFiles: rows.filter((row) => supportsImports(row.language)).length,
      filesWithImports: new Set(edges.map((e) => e.sourcePath)).size,
      resolvedEdges: edges.filter((e) => e.kind === "resolved").length,
      externalEdges: edges.filter((e) => e.kind === "external").length,
      unresolvedEdges: edges.filter((e) => e.kind === "unresolved").length,
      languagesWithoutImports: languagesPresent.filter((l) => !supportsImports(l)),
      tsconfigAliasesLoaded: aliases !== null,
      // A floor on how much of the graph is real. A large number here means the
      // scanner is weaker than the edge count suggests.
      filesWithIncompleteImportScan: incompleteScans.size,
    };

    const structureWithCoverage = { ...structure, coverage };

    /**
     * The file rows and the terminal status commit together.
     *
     * `ready` must never be observable without the rows behind it. A reader that saw
     * `ready` against a half-written list would answer from a partial repository and
     * have no way to know — the same trap truncation sets, arrived at from the other
     * direction. deleteMany first so a retry after an interrupted run replaces its
     * partial rows rather than colliding with them.
     */
    /**
     * INTERACTIVE transaction, where the rest of this codebase uses the array form.
     *
     * The array form cannot express this: edges reference RepositoryFile ids, and those
     * ids do not exist until the files are inserted. `createManyAndReturn` hands them
     * back in the same round trip, so the alternative — generating ids client-side to
     * keep the array form — buys nothing and puts a second id format in the column.
     *
     * The atomicity guarantee is unchanged and is the reason this stays one
     * transaction: `ready` must never be observable without the rows behind it. Edges
     * join that guarantee rather than weakening it — a repository marked ready with
     * files but no edges would be indistinguishable from one whose imports resolved to
     * nothing, which is the exact confusion FileEdge exists to prevent.
     *
     * The timeout is explicit because the default is 5s and this now does three writes
     * over up to MAX_INDEXED_FILES rows plus their edges. Reaching the default and
     * rolling back would leave the repository in `indexing` forever, which reads to a
     * user as a hang rather than a failure.
     */
    await prisma.$transaction(
      async (tx) => {
        // deleteMany first so a retry after an interrupted run replaces its partial
        // rows rather than colliding with them. Edges cascade from the files, so this
        // one statement is also what makes re-ingestion idempotent for the graph.
        await tx.repositoryFile.deleteMany({ where: { repositoryId: repository.id } });

        const written = await tx.repositoryFile.createManyAndReturn({
          data: rows,
          skipDuplicates: true,
          select: { id: true, path: true },
        });

        const idByPath = new Map(written.map((row) => [row.path, row.id]));

        const edgeRows = edges.flatMap((edge) => {
          const sourceFileId = idByPath.get(edge.sourcePath);
          // Cannot happen for rows just written, and checked anyway: a missing id here
          // would be a foreign key violation that fails the whole ingestion, and
          // dropping one edge is a far better outcome than losing the index.
          if (!sourceFileId) return [];
          return [
            {
              repositoryId: repository.id,
              sourceFileId,
              targetFileId: edge.targetPath ? (idByPath.get(edge.targetPath) ?? null) : null,
              specifier: edge.specifier,
              kind: edge.kind,
            },
          ];
        });

        if (edgeRows.length > 0) {
          // skipDuplicates against the (sourceFileId, specifier) unique index: the
          // database, not this loop, is what guarantees one edge per import.
          await tx.fileEdge.createMany({ data: edgeRows, skipDuplicates: true });
        }

        await tx.repository.update({
          where: { id: repository.id },
          data: {
            status: "ready",
            error: null,
            fileCount: rows.length,
            primaryLanguage: language,
            symbolsExtracted,
            importsExtracted,
            structure: structureWithCoverage as unknown as object,
          },
        });
      },
      { timeout: 60_000, maxWait: 15_000 }
    );

    /**
     * Duration and size are logged from the first version on purpose.
     *
     * Ingestion runs single-shot inside one request, which is fine until it is not.
     * When a large repository eventually times out, the threshold should come from
     * these numbers rather than from a guess about where it broke.
     */
    logger.info("Indexed a repository", {
      owner: ref.owner,
      name: ref.name,
      commitSha: meta.commitSha.slice(0, 8),
      files: rows.length,
      sourceFiles: structure.sourceFiles,
      totalBytes: tree.entries.reduce((sum, e) => sum + e.size, 0),
      primaryLanguage: language,
      symbolsExtracted,
      filesWithSymbols: symbolsByPath.size,
      filesWithInternalSymbols: internalByPath.size,
      importsExtracted,
      edges: edges.length,
      resolvedEdges: edges.filter((e) => e.kind === "resolved").length,
      unresolvedEdges: edges.filter((e) => e.kind === "unresolved").length,
      tsconfigAliasesLoaded: aliases !== null,
      archiveMs,
      totalMs: Date.now() - ingestStarted,
    });

    return {
      ok: true,
      repositoryId: repository.id,
      fileCount: rows.length,
      reused: false,
      coverage,
    };
  } catch (error) {
    const message = describe(error);
    await fail(repository.id, message);
    return { ok: false, error: message };
  }
}

/**
 * Pull coverage out of a stored `structure` blob without trusting its shape.
 *
 * The column is Json and predates this field, so rows written by earlier versions have
 * no coverage at all. Returning undefined for those is deliberate: describeCoverage
 * then says nothing, rather than reporting a confident zero for something that was
 * never measured.
 */
function readCoverage(structure: unknown): IndexCoverage | undefined {
  if (typeof structure !== "object" || structure === null) return undefined;
  const coverage = (structure as Record<string, unknown>).coverage;
  if (typeof coverage !== "object" || coverage === null) return undefined;

  const c = coverage as Record<string, unknown>;
  if (typeof c.indexedFiles !== "number" || typeof c.symbolsExtracted !== "boolean") {
    return undefined;
  }
  return coverage as unknown as IndexCoverage;
}

/** Record why an index could not be built, so the UI can say more than "failed". */
async function fail(repositoryId: string, error: string): Promise<void> {
  try {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: "failed", error },
    });
  } catch (updateError) {
    // The index is already unusable; losing the reason must not mask the original
    // failure the caller is about to be told about.
    logger.warn("Could not record a repository ingestion failure", {
      repositoryId,
      error: updateError instanceof Error ? updateError.message : "unknown",
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  return "Could not index that repository. Try again shortly.";
}
