import { describe, it, expect } from "vitest";
import {
  fetchFilesInOrder,
  REPOSITORY_FETCH_CONCURRENCY,
  type RepoRef,
} from "@/lib/repo/github";
import { ContextManager } from "@/lib/ai/context-manager";

/**
 * The bounded, order-preserving file fetch pool.
 *
 * WHY IT REPLACED A SERIAL LOOP. Reading ten files one await at a time cost 3.4-3.6
 * seconds of every repo-backed turn, for requests with no ordering dependency between
 * them. Measured on three real ky questions: serial 3,632 / 3,389 / 3,462 ms against
 * pooled 1,193 / 893 / 1,023 ms.
 *
 * THE TWO PROPERTIES A NAIVE REWRITE LOSES, and both are tested here rather than
 * assumed. Promise.all abandons every other read on the first rejection, which turns
 * one unreadable file into a turn with no repository context at all. And completion
 * order is latency order, not selection order — letting it through would silently
 * re-rank the repository, because the packer fills its budget in order.
 *
 * Fixtures use LITERAL counts and an injected reader, so nothing here depends on the
 * network or on the constant under test.
 */

const ref: RepoRef = { owner: "o", name: "r" };
const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];

/** A reader that resolves after a delay, so completion order differs from input order. */
const delayedReader =
  (delays: Record<string, number>) =>
  async (_r: RepoRef, _s: string, path: string): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, delays[path] ?? 0));
    return `content of ${path}`;
  };

describe("ordering", () => {
  it("returns files in INPUT order even when they finish backwards", async () => {
    // The first path is slowest, the last is fastest: completion order is the exact
    // reverse of input order, so anything that pushes on completion fails here.
    const delays = { "a.ts": 40, "b.ts": 30, "c.ts": 20, "d.ts": 10 };
    const four = ["a.ts", "b.ts", "c.ts", "d.ts"];

    const out = await fetchFilesInOrder(ref, "sha", four, 4, delayedReader(delays));

    expect(out.map((r) => r.path)).toEqual(four);
    expect(out.map((r) => r.content)).toEqual(four.map((p) => `content of ${p}`));
  });

  it("keeps order across pool waves", async () => {
    // Eight files through a pool of three means three waves; a worker finishing early
    // picks up a later index, so index-based placement is what holds this together.
    const out = await fetchFilesInOrder(ref, "sha", paths, 3, delayedReader({ "a.ts": 25 }));

    expect(out.map((r) => r.path)).toEqual(paths);
  });

  it("preserves order through a failure in the middle", async () => {
    const read = async (_r: RepoRef, _s: string, path: string): Promise<string> => {
      if (path === "c.ts") throw new Error("404 not found");
      return `content of ${path}`;
    };

    const out = await fetchFilesInOrder(ref, "sha", paths, 4, read);

    expect(out.map((r) => r.path)).toEqual(paths);
    expect(out[2].content).toBeNull();
    expect(out[2].error).toBe("404 not found");
  });
});

describe("failure isolation", () => {
  it("keeps every other file when one read rejects", async () => {
    // THE PROPERTY Promise.all DESTROYS. One 404 must cost one file, not the turn.
    const read = async (_r: RepoRef, _s: string, path: string): Promise<string> => {
      if (path === "b.ts") throw new Error("boom");
      return `content of ${path}`;
    };

    const out = await fetchFilesInOrder(ref, "sha", paths, 4, read);

    expect(out.filter((r) => r.content !== null)).toHaveLength(7);
    expect(out.filter((r) => r.error !== null)).toHaveLength(1);
  });

  it("survives every read failing", async () => {
    const read = async (): Promise<string> => {
      throw new Error("github down");
    };

    const out = await fetchFilesInOrder(ref, "sha", paths, 4, read);

    expect(out).toHaveLength(8);
    expect(out.every((r) => r.content === null && r.error === "github down")).toBe(true);
  });

  it("reports a non-Error rejection rather than dropping it", async () => {
    const read = async (): Promise<string> => {
      throw "a string, not an Error";
    };

    const out = await fetchFilesInOrder(ref, "sha", ["a.ts"], 1, read);

    expect(out[0].error).toBe("unknown");
    expect(out[0].content).toBeNull();
  });

  it("never returns an entry with both content and error", async () => {
    const read = async (_r: RepoRef, _s: string, path: string): Promise<string> => {
      if (path === "d.ts") throw new Error("nope");
      return "ok";
    };

    const out = await fetchFilesInOrder(ref, "sha", paths, 3, read);

    for (const r of out) {
      expect(r.content === null || r.error === null).toBe(true);
    }
  });
});

describe("the concurrency ceiling", () => {
  it("never exceeds the requested concurrency", async () => {
    /**
     * THE BUDGET THAT IS NOT OURS ALONE. One shared GitHub token serves every user, and
     * ten-wide bursts from several turns at once is how a secondary rate limit gets
     * tripped for everybody. Counted at the peak rather than inferred from timing.
     */
    let inFlight = 0;
    let peak = 0;
    const read = async (): Promise<string> => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return "ok";
    };

    await fetchFilesInOrder(ref, "sha", paths, 3, read);

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3);
  });

  it("actually runs concurrently rather than one at a time", async () => {
    // A pool that silently serialised would pass every ordering test above.
    let peak = 0;
    let inFlight = 0;
    const read = async (): Promise<string> => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return "ok";
    };

    await fetchFilesInOrder(ref, "sha", paths, 4, read);

    expect(peak).toBeGreaterThan(1);
  });

  it("does not start more workers than there are files", async () => {
    let peak = 0;
    let inFlight = 0;
    const read = async (): Promise<string> => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return "ok";
    };

    await fetchFilesInOrder(ref, "sha", ["only.ts"], 10, read);

    expect(peak).toBe(1);
  });

  it("ships a bounded default, not unbounded", async () => {
    // Literal: five was chosen because it recovers most of the serial cost at half the
    // burst of ten. Unbounded was measured only 200-380ms faster.
    expect(REPOSITORY_FETCH_CONCURRENCY).toBe(5);
    expect(REPOSITORY_FETCH_CONCURRENCY).toBeGreaterThan(1);
    expect(REPOSITORY_FETCH_CONCURRENCY).toBeLessThan(10);
  });

  it("returns immediately for no paths", async () => {
    expect(await fetchFilesInOrder(ref, "sha", [], 5, async () => "x")).toEqual([]);
  });
});

describe("the zero-selection note", () => {
  const base = { id: "u", role: "user" as const, content: "how does retry work?" };

  it("uses its own header, not the unavailable one", async () => {
    /**
     * THE DISTINCTION. A repository that was searched and matched nothing is not a
     * repository that could not be read, and saying "unavailable" for the first trains
     * the reader to ignore the notice for the second.
     */
    const result = ContextManager.buildContext([], base, null, {
      repositoryNote: "nothing matched closely enough",
      repositoryNoteKind: "no-match",
      contextTokens: 100_000,
    });

    expect(result.contextBlocks).toContain("REPOSITORY SEARCHED, NO FILE MATCHED");
    expect(result.contextBlocks).not.toContain("REPOSITORY CONTEXT UNAVAILABLE");
    expect(result.contextBlocks).toContain("nothing matched closely enough");
  });

  it("still renders the unavailable header for a load failure", async () => {
    const result = ContextManager.buildContext([], base, null, {
      repositoryNote: "could not be read",
      repositoryNoteKind: "unavailable",
      contextTokens: 100_000,
    });

    expect(result.contextBlocks).toContain("REPOSITORY CONTEXT UNAVAILABLE");
    expect(result.contextBlocks).not.toContain("NO FILE MATCHED");
  });

  it("falls back to the old inference when no kind is given", async () => {
    // Existing callers must behave exactly as they did.
    const result = ContextManager.buildContext([], base, null, {
      repositoryNote: "could not be read",
      contextTokens: 100_000,
    });

    expect(result.contextBlocks).toContain("REPOSITORY CONTEXT UNAVAILABLE");
  });
});
