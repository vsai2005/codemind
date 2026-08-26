import { logger } from "@/lib/logger";

/**
 * The GitHub REST calls repository ingestion needs. Five, across four functions:
 * repo, branch, tree and tarball for indexing, and contents for reading one file
 * at query time.
 *
 * WHY NOT AN SDK
 * @octokit would bring a large dependency tree to wrap a handful of endpoints we call with
 * fixed shapes. Configuring it is more code than this file, and it would still need
 * the same timeout and rate-limit handling written around it.
 *
 * WHY THE CALL COUNTS MATTER
 * The tree endpoint returns the ENTIRE file list — path, size and blob sha for every
 * entry — in ONE request, recursively. Fetching a file's contents costs one request
 * per file. So indexing is nearly free and reading is what spends the budget, which is
 * why the index stores `size` and the selector decides what is worth fetching before
 * spending anything.
 *
 * AUTHENTICATION
 * Unauthenticated GitHub allows 60 requests/hour, which cannot index anything real.
 * A server-side token raises that to ~5,000/hour. The token is read from the
 * environment and is NEVER accepted from a client — a caller-supplied token would let
 * anyone borrow the server's identity, and (once private repos exist) read repositories
 * this deployment should not see.
 */

const GITHUB_API = "https://api.github.com";

/** Matches the provider header timeout: a hung request must not stall ingestion. */
const GITHUB_TIMEOUT_MS = 15_000;

/**
 * Hard cap on a single file fetched for context.
 *
 * Selection already budgets by `size`, so this is the backstop for a file that is
 * enormous on its own — a bundled asset or a generated lockfile that slipped through
 * the extension filter. Fetching it would spend the request and then be discarded by
 * the token clamp anyway.
 */
export const MAX_FILE_BYTES = 256 * 1024;

export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoMeta {
  defaultBranch: string;
  commitSha: string;
}

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

export interface RepoTree {
  entries: TreeEntry[];
  /**
   * GitHub sets this when the tree exceeds its response limits (~100k entries or
   * 7 MB) and silently returns a PARTIAL list. An index built from a truncated tree
   * looks complete and is not, which is the worst failure this feature can have: every
   * later answer would be confidently wrong about the files it never saw. Callers must
   * treat this as a hard failure, never a warning.
   */
  truncated: boolean;
}

export type GitHubFailure =
  | { kind: "not_found" }
  | { kind: "rate_limited"; resetAt: number | null }
  | { kind: "too_large" }
  /**
   * `retryable` splits what this kind used to conflate.
   *
   * Every non-404, non-rate-limit response landed here — a 502 from GitHub's edge and
   * a 401 from a revoked token were the same value. Retrying is right for the first
   * and pure waste for the second, so the distinction has to be carried, not inferred
   * later from a `detail` string.
   */
  | { kind: "unavailable"; detail: string; retryable: boolean };

export class GitHubError extends Error {
  constructor(readonly failure: GitHubFailure, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * Statuses worth trying again. Everything absent from this set is a statement about
 * the REQUEST — bad credentials, a malformed ref, a repository that is not there —
 * and repeating it unchanged spends quota to receive the identical answer.
 *
 * 5xx is the transient family. 408 and 425 are the two 4xx that describe timing rather
 * than the request itself.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

/** Attempts per logical request, including the first. */
const MAX_ATTEMPTS = 3;

/** First backoff step; doubles per attempt before jitter. */
const BASE_BACKOFF_MS = 500;

/** Ceiling on a single backoff step, so exponential growth cannot run away. */
const MAX_BACKOFF_MS = 4_000;

/**
 * How long a rate-limit reset may be waited out inline.
 *
 * GitHub's primary limit resets hourly. Waiting that out inside a request would hold a
 * connection for the better part of an hour, so only a reset that is imminent is worth
 * sleeping through; anything further is returned to the caller with the reset time so
 * the user can be told WHEN to retry rather than only that it failed.
 */
const RATE_LIMIT_MAX_WAIT_MS = 20_000;

/**
 * Ceiling on total wall-clock for one ingestion, retries and rate-limit waits included.
 *
 * Ingestion is four requests regardless of repository size — repo, branch, tree,
 * tarball — so this is not defending against a per-file loop; there isn't one during
 * ingestion. It bounds the pathological case where every request retries to exhaustion
 * and each waits out a near rate-limit reset, which is minutes of wall-clock for an
 * operation the user is waiting on.
 */
export const INGEST_DEADLINE_MS = 90_000;

export interface GitHubRequestOptions {
  /**
   * Absolute epoch-ms after which no further attempt may START. An in-flight request
   * is allowed to finish; this bounds new work, not work already begun.
   */
  deadline?: number;
  signal?: AbortSignal;
}

/** A deadline for one whole ingestion, to thread through its four requests. */
export function ingestDeadline(now: number = Date.now()): number {
  return now + INGEST_DEADLINE_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with FULL jitter: a random point in [0, step], not step itself.
 *
 * Concurrent ingestions that fail together would otherwise retry in lockstep and
 * rebuild the same spike that failed them. Randomising the whole interval spreads them
 * rather than merely offsetting them.
 */
function backoffFor(attempt: number): number {
  const step = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.floor(Math.random() * step);
}

/** True when the failure is worth spending another attempt on. */
function isRetryable(failure: GitHubFailure): boolean {
  return failure.kind === "unavailable" && failure.retryable;
}

function token(): string | null {
  const raw = process.env.GITHUB_TOKEN?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** True when a server-side token is configured. Surfaces "60/hour" as a real answer. */
export function isGitHubConfigured(): boolean {
  return token() !== null;
}

/**
 * Accept only what is unambiguously a public GitHub repository URL.
 *
 * Deliberately strict rather than forgiving: a URL we cannot parse confidently is one
 * whose host we have not actually verified, and this function is the only thing
 * standing between a user-supplied string and an outbound server request. Anything
 * that is not github.com is rejected rather than guessed at.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  // Only the web schemes. Not currently exploitable — the scheme is discarded when the
  // API URL is built — but this function's answer means "this is a public GitHub
  // repository URL", and ftp://github.com/foo/bar is not one. Accepting it would mean
  // silently reinterpreting a URL the user did not write.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // Exact host match. "github.com.evil.test" must not pass, and neither must a
  // self-hosted Enterprise host, which is out of scope and has a different API base.
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;

  const owner = parts[0];
  // Tolerate the .git suffix people paste from clone URLs.
  const name = parts[1].replace(/\.git$/i, "");

  // GitHub's own naming rules. Rejecting here keeps malformed segments out of a URL
  // we are about to construct.
  const segment = /^[A-Za-z0-9._-]+$/;
  if (!segment.test(owner) || !segment.test(name)) return null;
  if (name === "." || name === "..") return null;

  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
}

/** One attempt. Network failures become a retryable typed failure rather than a throw. */
async function attemptFetch(path: string, accept: string, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub asks for a User-Agent and rejects requests without one.
    "User-Agent": "CodeMind",
  };
  const auth = token();
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

  try {
    return await fetch(`${GITHUB_API}${path}`, { headers, signal: controller.signal });
  } catch (error) {
    // A caller-initiated abort is not a GitHub problem and must not be retried —
    // the work has been cancelled, so trying again would ignore that.
    if (signal?.aborted) {
      throw new GitHubError(
        { kind: "unavailable", detail: "aborted", retryable: false },
        "The request was cancelled."
      );
    }
    // Everything else here is a transport failure: DNS, connection reset, or our own
    // 15s timeout firing. All are worth another attempt.
    throw new GitHubError(
      { kind: "unavailable", detail: error instanceof Error ? error.name : "fetch failed", retryable: true },
      "Could not reach GitHub."
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * A GitHub request, retried when — and only when — retrying could change the answer.
 *
 * Before this there was one attempt and a throw, so a single 502 from GitHub's edge
 * failed an entire ingestion with nothing recoverable. Three things bound the retrying:
 *
 *   attempts   MAX_ATTEMPTS per logical request, so one endpoint cannot loop
 *   deadline   an ingestion-wide budget, so four retrying requests cannot compound
 *   kind       only `unavailable` with retryable:true — a 404 or a 401 never repeats
 *
 * Rate limiting is handled rather than merely reported: a reset that is imminent is
 * slept through and retried, and one that is not is returned immediately carrying its
 * reset time so the caller can say when to come back.
 */
async function githubFetch(
  path: string,
  accept = "application/vnd.github+json",
  options: GitHubRequestOptions = {}
): Promise<Response> {
  const deadline = options.deadline;
  let lastError: GitHubError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;

    try {
      response = await attemptFetch(path, accept, options.signal);
    } catch (error) {
      const failure = error instanceof GitHubError ? error : null;
      if (!failure || !isRetryable(failure.failure)) throw error;
      lastError = failure;
      if (!(await waitBeforeRetry(attempt, deadline, path, failure))) throw failure;
      continue;
    }

    if (response.ok) return response;

    const failure = classify(response);

    // Rate limiting is its own decision: the wait is dictated by the reset header, not
    // by backoff, and exhausting attempts against it would just burn them instantly.
    if (failure.failure.kind === "rate_limited") {
      const waitMs = rateLimitWaitMs(failure.failure.resetAt, deadline);
      if (waitMs === null) throw failure;
      logger.warn("GitHub rate limit hit; waiting for reset", {
        path,
        waitMs,
        resetAt: failure.failure.resetAt,
      });
      await sleep(waitMs);
      continue;
    }

    if (!isRetryable(failure.failure)) throw failure;
    lastError = failure;
    if (!(await waitBeforeRetry(attempt, deadline, path, failure))) throw failure;
  }

  throw (
    lastError ??
    new GitHubError(
      { kind: "unavailable", detail: "retries_exhausted", retryable: false },
      "GitHub could not be reached after several attempts. Try again shortly."
    )
  );
}

/**
 * Sleep before the next attempt, or report that there must not be one.
 *
 * Returns false when the attempts are spent or the backoff would cross the deadline —
 * sleeping up to a deadline only to refuse the attempt afterwards would spend the
 * user's time to achieve nothing.
 */
async function waitBeforeRetry(
  attempt: number,
  deadline: number | undefined,
  path: string,
  failure: GitHubError
): Promise<boolean> {
  if (attempt >= MAX_ATTEMPTS) return false;

  const waitMs = backoffFor(attempt);
  if (deadline !== undefined && Date.now() + waitMs >= deadline) return false;

  logger.debug("Retrying GitHub request", {
    path,
    attempt,
    waitMs,
    reason: failure.failure.kind === "unavailable" ? failure.failure.detail : failure.failure.kind,
  });
  await sleep(waitMs);
  return true;
}

/**
 * How long to wait for a rate-limit reset, or null when waiting is the wrong answer.
 *
 * Null for an unknown reset, one already past, one further out than
 * RATE_LIMIT_MAX_WAIT_MS, or one that would cross the ingestion deadline. In every
 * case the caller receives the typed failure with `resetAt` intact, which is what lets
 * the user be told when to retry.
 */
function rateLimitWaitMs(resetAt: number | null, deadline: number | undefined): number | null {
  if (resetAt === null) return null;

  const waitMs = resetAt - Date.now();
  if (waitMs <= 0 || waitMs > RATE_LIMIT_MAX_WAIT_MS) return null;
  if (deadline !== undefined && Date.now() + waitMs >= deadline) return null;

  return waitMs;
}

/**
 * Turn a non-OK response into a typed failure.
 *
 * 404 covers both "no such repository" and "private repository" — GitHub deliberately
 * does not distinguish them for an unauthorised caller, and neither do we. Reporting
 * "this repository is private" would confirm its existence to someone who cannot see
 * it.
 */
function classify(response: Response): GitHubError {
  if (response.status === 404) {
    return new GitHubError(
      { kind: "not_found" },
      "That repository could not be found. It may be private, renamed, or misspelled — only public repositories are supported."
    );
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  if ((response.status === 403 || response.status === 429) && remaining === "0") {
    const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
    return new GitHubError(
      { kind: "rate_limited", resetAt: Number.isFinite(reset) ? reset * 1000 : null },
      "GitHub's API rate limit has been reached. Try again shortly."
    );
  }

  // The split that makes retrying safe. A 502 is GitHub having a moment; a 401 is a
  // revoked token and a 422 is a malformed ref, and repeating either spends quota to
  // be told the same thing again.
  const retryable = RETRYABLE_STATUSES.has(response.status);

  return new GitHubError(
    { kind: "unavailable", detail: `http_${response.status}`, retryable },
    retryable
      ? "GitHub returned a temporary error. Try again shortly."
      : "GitHub returned an unexpected response."
  );
}

/** Default branch and its head commit. One request. */
export async function fetchRepoMeta(
  ref: RepoRef,
  options: GitHubRequestOptions = {}
): Promise<RepoMeta> {
  const response = await githubFetch(`/repos/${ref.owner}/${ref.name}`, undefined, options);
  if (!response.ok) throw classify(response);

  const body = (await response.json()) as { default_branch?: unknown };
  const defaultBranch = typeof body.default_branch === "string" ? body.default_branch : null;
  if (!defaultBranch) {
    throw new GitHubError({ kind: "unavailable", detail: "no_default_branch", retryable: false }, "GitHub returned an unexpected response.");
  }

  // The branch ref resolves to the commit this snapshot is pinned to.
  const branch = await githubFetch(
    `/repos/${ref.owner}/${ref.name}/branches/${encodeURIComponent(defaultBranch)}`,
    undefined,
    options
  );
  if (!branch.ok) throw classify(branch);

  const branchBody = (await branch.json()) as { commit?: { sha?: unknown } };
  const commitSha = typeof branchBody.commit?.sha === "string" ? branchBody.commit.sha : null;
  if (!commitSha) {
    throw new GitHubError({ kind: "unavailable", detail: "no_commit_sha", retryable: false }, "GitHub returned an unexpected response.");
  }

  return { defaultBranch, commitSha };
}

/**
 * The whole file list in one request.
 *
 * Only blobs are returned — directory entries carry no size and nothing fetches them.
 * `truncated` is passed through untouched for the caller to reject; swallowing it here
 * would produce exactly the silently-partial index this feature must not have.
 */
export async function fetchTree(
  ref: RepoRef,
  commitSha: string,
  options: GitHubRequestOptions = {}
): Promise<RepoTree> {
  const response = await githubFetch(
    `/repos/${ref.owner}/${ref.name}/git/trees/${commitSha}?recursive=1`,
    undefined,
    options
  );
  if (!response.ok) throw classify(response);

  const body = (await response.json()) as {
    tree?: unknown;
    truncated?: unknown;
  };

  const raw = Array.isArray(body.tree) ? body.tree : [];
  const entries: TreeEntry[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "blob") continue;
    if (typeof entry.path !== "string" || typeof entry.sha !== "string") continue;
    entries.push({
      path: entry.path,
      blobSha: entry.sha,
      size: typeof entry.size === "number" ? entry.size : 0,
    });
  }

  return { entries, truncated: body.truncated === true };
}

/**
 * The whole repository as a gzipped tar, in ONE request.
 *
 * Measured at one rate-limit unit regardless of size (see lib/repo/archive.ts for the
 * numbers). Returns the response body as a stream so the caller can decompress
 * incrementally rather than buffering an entire repository on a 512 MB instance.
 *
 * GitHub answers with a 302 to codeload.github.com; fetch follows it automatically and
 * the redirect target does not consume additional quota.
 */
export async function fetchTarball(
  ref: RepoRef,
  commitSha: string,
  options: GitHubRequestOptions = {}
): Promise<ReadableStream<Uint8Array>> {
  const response = await githubFetch(
    `/repos/${ref.owner}/${ref.name}/tarball/${commitSha}`,
    undefined,
    options
  );
  if (!response.ok) throw classify(response);
  if (!response.body) {
    throw new GitHubError({ kind: "unavailable", detail: "empty_archive", retryable: false }, "GitHub returned an empty archive.");
  }
  return response.body;
}

/**
 * One file's contents, by path at a pinned commit.
 *
 * Uses the raw media type so the response is the file itself rather than base64 inside
 * JSON — half the bytes and no decode step, which matters on a 512 MB instance.
 */
export async function fetchFileContent(
  ref: RepoRef,
  commitSha: string,
  path: string
): Promise<string> {
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const response = await githubFetch(
    `/repos/${ref.owner}/${ref.name}/contents/${encoded}?ref=${commitSha}`,
    "application/vnd.github.raw+json"
  );
  if (!response.ok) throw classify(response);

  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_FILE_BYTES) {
    throw new GitHubError({ kind: "too_large" }, "That file is too large to read.");
  }

  const text = await response.text();
  if (text.length > MAX_FILE_BYTES) {
    logger.debug("Truncating an oversized repository file", { path, bytes: text.length });
    return text.slice(0, MAX_FILE_BYTES);
  }
  return text;
}
