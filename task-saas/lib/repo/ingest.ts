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
    let symbolsExtracted = false;
    const archiveStarted = Date.now();

    if (language && supportsSymbols(language)) {
      try {
        const stream = await fetchTarball(ref, meta.commitSha, { deadline });
        await readTarball(stream, (entry) => {
          if (!supportsSymbols(languageForPath(entry.path))) return;
          const symbols = extractSymbols(entry.content);
          if (symbols.length > 0) symbolsByPath.set(entry.path, symbols);
          // Internal declarations are what make a file whose meaning lives in private
          // members findable at all — see extractInternalSymbols.
          const internal = extractInternalSymbols(entry.content, symbols);
          if (internal.length > 0) internalByPath.set(entry.path, internal);
        });
        symbolsExtracted = true;
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

    const coverage = {
      indexedFiles: rows.length,
      symbolEligibleFiles: rows.filter((row) => supportsSymbols(row.language)).length,
      filesWithSymbols: rows.filter(
        (row) => row.symbols.length > 0 || row.internalSymbols.length > 0
      ).length,
      languages: languagesPresent,
      languagesWithoutSymbols: languagesPresent.filter((l) => !supportsSymbols(l)),
      symbolsExtracted,
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
    await prisma.$transaction([
      prisma.repositoryFile.deleteMany({ where: { repositoryId: repository.id } }),
      prisma.repositoryFile.createMany({ data: rows, skipDuplicates: true }),
      prisma.repository.update({
        where: { id: repository.id },
        data: {
          status: "ready",
          error: null,
          fileCount: rows.length,
          primaryLanguage: language,
          symbolsExtracted,
          structure: structureWithCoverage as unknown as object,
        },
      }),
    ]);

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
