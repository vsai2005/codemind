import { logger } from "@/lib/logger";

/**
 * The GitHub REST calls repository ingestion needs. Three endpoints, nothing more.
 *
 * WHY NOT AN SDK
 * @octokit would bring a large dependency tree to wrap three endpoints we call with
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
  | { kind: "unavailable"; detail: string };

export class GitHubError extends Error {
  constructor(readonly failure: GitHubFailure, message: string) {
    super(message);
    this.name = "GitHubError";
  }
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

async function githubFetch(path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub asks for a User-Agent and rejects requests without one.
    "User-Agent": "CodeMind",
  };
  const auth = token();
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

  try {
    return await fetch(`${GITHUB_API}${path}`, { headers, signal: controller.signal });
  } catch (error) {
    throw new GitHubError(
      { kind: "unavailable", detail: error instanceof Error ? error.name : "fetch failed" },
      "Could not reach GitHub."
    );
  } finally {
    clearTimeout(timer);
  }
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

  return new GitHubError(
    { kind: "unavailable", detail: `http_${response.status}` },
    "GitHub returned an unexpected response. Try again shortly."
  );
}

/** Default branch and its head commit. One request. */
export async function fetchRepoMeta(ref: RepoRef): Promise<RepoMeta> {
  const response = await githubFetch(`/repos/${ref.owner}/${ref.name}`);
  if (!response.ok) throw classify(response);

  const body = (await response.json()) as { default_branch?: unknown };
  const defaultBranch = typeof body.default_branch === "string" ? body.default_branch : null;
  if (!defaultBranch) {
    throw new GitHubError({ kind: "unavailable", detail: "no_default_branch" }, "GitHub returned an unexpected response.");
  }

  // The branch ref resolves to the commit this snapshot is pinned to.
  const branch = await githubFetch(
    `/repos/${ref.owner}/${ref.name}/branches/${encodeURIComponent(defaultBranch)}`
  );
  if (!branch.ok) throw classify(branch);

  const branchBody = (await branch.json()) as { commit?: { sha?: unknown } };
  const commitSha = typeof branchBody.commit?.sha === "string" ? branchBody.commit.sha : null;
  if (!commitSha) {
    throw new GitHubError({ kind: "unavailable", detail: "no_commit_sha" }, "GitHub returned an unexpected response.");
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
export async function fetchTree(ref: RepoRef, commitSha: string): Promise<RepoTree> {
  const response = await githubFetch(
    `/repos/${ref.owner}/${ref.name}/git/trees/${commitSha}?recursive=1`
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
