import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { fetchRepoMeta, fetchTree, GitHubError, ingestDeadline } from "@/lib/repo/github";

/**
 * Resilience of the GitHub client.
 *
 * Before this there was one attempt, a 15s abort timeout, and a throw. A single 502
 * from GitHub's edge failed an entire ingestion with nothing recoverable, and a hit
 * rate-limit window did the same while holding the reset time it could have reported.
 *
 * The distinction these tests exist to protect is which failures are worth repeating.
 * `classify` used to return the same `unavailable` value for a 502 and a 401 — one is
 * GitHub having a moment, the other is a revoked token, and retrying the second spends
 * quota to be told the same thing three times.
 *
 * Every test drives the real client through a mocked global fetch, so the retry loop,
 * the classifier and the deadline are all genuinely exercised.
 */

const REF = { owner: "sindresorhus", name: "p-limit" };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A 403 carrying the rate-limit headers GitHub actually sends. */
function rateLimited(resetAtMs: number): Response {
  return jsonResponse({ message: "rate limited" }, 403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(Math.floor(resetAtMs / 1000)),
  });
}

/** The two responses a successful fetchRepoMeta needs, in order. */
const META_OK = [
  () => jsonResponse({ default_branch: "main" }),
  () => jsonResponse({ commit: { sha: "df476048" } }),
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.GITHUB_TOKEN = "ghp_test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.GITHUB_TOKEN;
});

/** Queue responses (or thrown errors) to be returned in order. */
function respondWith(...steps: Array<() => Response | never>): void {
  let i = 0;
  fetchMock.mockImplementation(() => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return Promise.resolve(step());
  });
}

describe("GitHub client resilience", () => {
  describe("transient failures", () => {
    it("retries a 502 and succeeds", async () => {
      respondWith(
        () => jsonResponse({ message: "bad gateway" }, 502),
        ...META_OK
      );

      const meta = await fetchRepoMeta(REF);

      expect(meta.commitSha).toBe("df476048");
      // 502, then the two requests fetchRepoMeta actually needs.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries a network throw and succeeds", async () => {
      let call = 0;
      fetchMock.mockImplementation(() => {
        call++;
        if (call === 1) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(META_OK[call - 2]?.() ?? jsonResponse({ commit: { sha: "x" } }));
      });

      const meta = await fetchRepoMeta(REF);
      expect(meta.defaultBranch).toBe("main");
    });

    it("gives up after the attempt ceiling rather than looping", async () => {
      respondWith(() => jsonResponse({ message: "unavailable" }, 503));

      await expect(fetchTree(REF, "sha")).rejects.toThrow(GitHubError);
      // MAX_ATTEMPTS is 3 — the ceiling, not "until it works".
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("permanent failures", () => {
    it("does NOT retry a 404", async () => {
      // The case that silently wastes quota if the classifier regresses: a missing or
      // private repository answers 404 every time, and asking again cannot change it.
      respondWith(() => jsonResponse({ message: "Not Found" }, 404));

      await expect(fetchRepoMeta(REF)).rejects.toMatchObject({
        failure: { kind: "not_found" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry a 401", async () => {
      // A revoked token. Previously indistinguishable from a 502 — both were
      // `unavailable` — so a blanket retry rule would have tripled the waste.
      respondWith(() => jsonResponse({ message: "Bad credentials" }, 401));

      await expect(fetchRepoMeta(REF)).rejects.toMatchObject({
        failure: { kind: "unavailable", retryable: false },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry a 422", async () => {
      respondWith(() => jsonResponse({ message: "Unprocessable" }, 422));

      await expect(fetchTree(REF, "sha")).rejects.toThrow(GitHubError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("rate limiting", () => {
    it("waits out a near reset and retries", async () => {
      // Two seconds out: inside RATE_LIMIT_MAX_WAIT_MS, so it is worth sleeping through.
      //
      // It cannot be smaller. x-ratelimit-reset is a UNIX timestamp in SECONDS, so any
      // reset under a second floors into the past and is correctly treated as already
      // expired — which is what a first draft of this test hit.
      respondWith(() => rateLimited(Date.now() + 2_000), ...META_OK);

      const meta = await fetchRepoMeta(REF);

      expect(meta.commitSha).toBe("df476048");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("fails fast on a far reset, carrying the reset time", async () => {
      // An hour out — GitHub's primary window. Waiting would hold the request for the
      // better part of an hour; the caller needs the time so the USER can be told when
      // to come back.
      const resetAt = Date.now() + 60 * 60 * 1000;
      respondWith(() => rateLimited(resetAt));

      const error = await fetchRepoMeta(REF).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GitHubError);
      const failure = (error as GitHubError).failure;
      expect(failure.kind).toBe("rate_limited");
      // Seconds-resolution header, so compare at that granularity.
      expect(
        Math.abs((failure as { resetAt: number }).resetAt - resetAt)
      ).toBeLessThan(1000);
      // Not retried: one attempt, then the typed failure.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not wait when the reset time is unknown", async () => {
      // 403 with remaining:0 but no parseable reset. Sleeping for an unknown period is
      // not an option, so this must surface immediately.
      respondWith(() =>
        jsonResponse({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0" })
      );

      await expect(fetchRepoMeta(REF)).rejects.toMatchObject({
        failure: { kind: "rate_limited", resetAt: null },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("overall ceiling", () => {
    it("refuses to start a retry past the deadline", async () => {
      respondWith(() => jsonResponse({ message: "unavailable" }, 503));

      // A deadline already in the past: the first attempt still runs, but no retry may
      // begin after it. Sleeping up to a deadline only to refuse the attempt afterwards
      // would spend the user's time to achieve nothing.
      const expired = ingestDeadline(Date.now()) - 200_000;

      await expect(fetchTree(REF, "sha", { deadline: expired })).rejects.toThrow(GitHubError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not wait out a rate limit that would cross the deadline", async () => {
      respondWith(() => rateLimited(Date.now() + 5_000));

      // The reset is near enough to wait for in principle, but the budget is nearly
      // spent — so the reset time is reported instead.
      const nearlyExpired = Date.now() + 100;

      await expect(
        fetchRepoMeta(REF, { deadline: nearlyExpired })
      ).rejects.toMatchObject({ failure: { kind: "rate_limited" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
