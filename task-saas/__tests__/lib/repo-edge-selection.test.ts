import { describe, it, expect } from "vitest";
import {
  expandAlongEdges,
  fallbackFiles,
  scoreFiles,
  type FileEdgeLink,
  type IndexedFile,
  type ScoredFile,
} from "@/lib/repo/selection";

/**
 * Import edges consumed by selection.
 *
 * TWO DIFFERENT JOBS, and the tests are split the same way because the risk differs.
 *
 * On the scored path expansion is additive: neighbours are appended after every file
 * that matched the question, so they can only take budget nothing else wanted. The
 * property to protect there is that this stays true — a neighbour outranking a match
 * would mean the graph overriding evidence with adjacency.
 *
 * On the fallback path expansion REPLACES part of an admitted guess. fallbackFiles runs
 * when nothing matched, and its second phase orders by depth and size because nothing
 * better was available. A file the entry point actually imports is better evidence than
 * "shallow and large", so it ranks above that sweep — and the tests pin that ordering,
 * because it is the one place where edges change what an existing turn would have sent.
 */

const file = (path: string, extra: Partial<IndexedFile> = {}): IndexedFile => ({
  path,
  size: 500,
  language: "typescript",
  ...extra,
});

const link = (fromPath: string, toPath: string): FileEdgeLink => ({ fromPath, toPath });

const paths = (files: readonly ScoredFile[]): string[] => files.map((f) => f.path);

describe("expandAlongEdges", () => {
  const files = [
    file("src/retry.ts"),
    file("src/http.ts"),
    file("src/backoff.ts"),
    file("src/unrelated.ts"),
  ];

  it("adds what a match imports and what imports it", () => {
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];
    const edges = [link("src/retry.ts", "src/backoff.ts"), link("src/http.ts", "src/retry.ts")];

    const result = expandAlongEdges(scored, files, edges, 3);

    expect(paths(result)).toEqual(["src/retry.ts", "src/backoff.ts", "src/http.ts"]);
  });

  it("orders dependencies before dependents", () => {
    // What a file imports usually explains how it works; what imports it shows how it
    // is used. The first answers more questions, so it wins when only some fit.
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];
    const edges = [link("src/http.ts", "src/retry.ts"), link("src/retry.ts", "src/backoff.ts")];

    const result = expandAlongEdges(scored, files, edges, 3);

    expect(paths(result).indexOf("src/backoff.ts")).toBeLessThan(
      paths(result).indexOf("src/http.ts")
    );
  });

  it("reserves the last guaranteed slot for the graph, ahead of weaker matches", () => {
    // THE BEHAVIOUR THIS CHANGE EXISTS FOR, and the assertion that used to say the
    // opposite. Neighbours previously queued behind every scored file, which with a
    // three-file cap made them unreachable whenever three files scored — measured as
    // identical selection on sindresorhus/ky.
    //
    // Now the best neighbour takes slot 3, displacing the THIRD-best keyword match.
    // The two strongest matches still precede it, always.
    const scored: ScoredFile[] = [
      { ...file("src/retry.ts"), score: 30 },
      { ...file("src/http.ts"), score: 20 },
      { ...file("src/unrelated.ts"), score: 1 },
    ];
    const edges = [link("src/retry.ts", "src/backoff.ts")];

    const result = expandAlongEdges(scored, files, edges, 3);

    expect(paths(result).slice(0, 3)).toEqual([
      "src/retry.ts",
      "src/http.ts",
      "src/backoff.ts",
    ]);
    // Displaced, not discarded: it still ranks after the reservation.
    expect(paths(result)).toContain("src/unrelated.ts");
  });

  it("keeps the top match ahead of the graph even at a cap of one", () => {
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];
    const edges = [link("src/retry.ts", "src/backoff.ts")];

    expect(paths(expandAlongEdges(scored, files, edges, 1))[0]).toBe("src/retry.ts");
  });

  it("ranks a neighbour reached by two seeds above one reached by a single seed", () => {
    // The ranking rule. Edge kind and hop distance are constant here — only resolved
    // edges are ever loaded, and expansion is one hop — so seed count is the one
    // signal that varies.
    const pool = [
      file("src/a.ts"),
      file("src/b.ts"),
      file("src/shared.ts"),
      file("src/only-a.ts"),
    ];
    const scored: ScoredFile[] = [
      { ...file("src/a.ts"), score: 30 },
      { ...file("src/b.ts"), score: 25 },
    ];
    const edges = [
      link("src/a.ts", "src/only-a.ts"),
      link("src/a.ts", "src/shared.ts"),
      link("src/b.ts", "src/shared.ts"),
    ];

    const result = expandAlongEdges(scored, pool, edges, 3);
    const names = paths(result);

    expect(names.indexOf("src/shared.ts")).toBeLessThan(names.indexOf("src/only-a.ts"));
  });

  it("breaks a rank tie by path, not by which seed happened to reach it first", () => {
    // A FALSE-NEGATIVE TEST WAS REPLACED BY THIS ONE. The shuffle test below cannot
    // catch a missing tie-break: candidates are sorted per seed before they are
    // recorded, so with a single seed the insertion order is already alphabetical and
    // removing the final comparator changes nothing.
    //
    // Two seeds are what separate them. Seeds are visited in score order, so "zeta"
    // (reached by the higher-scoring seed) is INSERTED first while "alpha" sorts
    // first. Equal seed counts and equal direction, so the path comparator is the only
    // thing that can decide.
    const pool = [
      file("src/b.ts"),
      file("src/a.ts"),
      file("src/zeta.ts"),
      file("src/alpha.ts"),
    ];
    const scored: ScoredFile[] = [
      { ...file("src/b.ts"), score: 30 },
      { ...file("src/a.ts"), score: 20 },
    ];
    const edges = [link("src/b.ts", "src/zeta.ts"), link("src/a.ts", "src/alpha.ts")];

    const result = paths(expandAlongEdges(scored, pool, edges, 3));

    expect(result.indexOf("src/alpha.ts")).toBeLessThan(result.indexOf("src/zeta.ts"));
  });

  it("ranks identically when the edge list is shuffled", () => {
    // Determinism against input order, not just against repeated calls. Insertion
    // order must not leak into the ranking.
    const pool = [file("src/a.ts"), file("src/x.ts"), file("src/y.ts"), file("src/z.ts")];
    const scored: ScoredFile[] = [{ ...file("src/a.ts"), score: 30 }];
    const edges = [
      link("src/a.ts", "src/z.ts"),
      link("src/a.ts", "src/x.ts"),
      link("src/a.ts", "src/y.ts"),
    ];

    const forward = paths(expandAlongEdges(scored, pool, edges, 3));
    const reversed = paths(expandAlongEdges(scored, pool, [...edges].reverse(), 3));
    const rotated = paths(expandAlongEdges(scored, pool, [edges[1], edges[2], edges[0]], 3));

    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("does not re-add a file that already scored", () => {
    const scored: ScoredFile[] = [
      { ...file("src/retry.ts"), score: 30 },
      { ...file("src/backoff.ts"), score: 12 },
    ];
    const edges = [link("src/retry.ts", "src/backoff.ts")];

    const result = expandAlongEdges(scored, files, edges, 3);

    expect(paths(result)).toEqual(["src/retry.ts", "src/backoff.ts"]);
  });

  it("ignores a self-edge, which names no new file", () => {
    // Guaranteed by the seed being excluded rather than by a self-edge check: the
    // dedicated guard turned out to be dead code and was removed. See neighboursOf.

    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];

    const result = expandAlongEdges(scored, files, [link("src/retry.ts", "src/retry.ts")], 3);

    expect(paths(result)).toEqual(["src/retry.ts"]);
  });

  it("caps how much any one hub can contribute", () => {
    // A real repository has modules imported by hundreds of files. Unbounded expansion
    // would turn "read the relevant files" into "read the repository".
    const many = Array.from({ length: 40 }, (_, i) => file(`src/caller${i}.ts`));
    const scored: ScoredFile[] = [{ ...file("src/hub.ts"), score: 30 }];
    const edges = many.map((f) => link(f.path, "src/hub.ts"));

    const result = expandAlongEdges(scored, [...many, file("src/hub.ts")], edges, 3);

    // Three per seed, and one seed here.
    expect(result.length).toBe(4);
  });

  it("spreads across seeds rather than exhausting the first", () => {
    const scored: ScoredFile[] = [
      { ...file("src/a.ts"), score: 30 },
      { ...file("src/b.ts"), score: 20 },
    ];
    const pool = [
      file("src/a.ts"),
      file("src/b.ts"),
      file("src/a1.ts"),
      file("src/a2.ts"),
      file("src/a3.ts"),
      file("src/a4.ts"),
      file("src/b1.ts"),
    ];
    const edges = [
      link("src/a.ts", "src/a1.ts"),
      link("src/a.ts", "src/a2.ts"),
      link("src/a.ts", "src/a3.ts"),
      link("src/a.ts", "src/a4.ts"),
      link("src/b.ts", "src/b1.ts"),
    ];

    const result = expandAlongEdges(scored, pool, edges, 3);

    // a4 is cut by the per-seed cap; b1 survives because it belongs to another seed.
    expect(paths(result)).not.toContain("src/a4.ts");
    expect(paths(result)).toContain("src/b1.ts");
  });

  it("returns the same order for the same input", () => {
    // A selection that varied between identical turns would make a wrong answer
    // impossible to reproduce.
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];
    const edges = [link("src/retry.ts", "src/http.ts"), link("src/retry.ts", "src/backoff.ts")];

    const first = paths(expandAlongEdges(scored, files, edges, 3));
    const second = paths(expandAlongEdges(scored, files, [...edges].reverse(), 3));

    expect(second).toEqual(first);
  });

  it("changes nothing when the repository has no graph", () => {
    // A snapshot indexed before edges existed, or a language whose imports are not
    // parsed. Degrading to the previous behaviour is the correct response to an absent
    // graph; inventing neighbours from path proximity would not be.
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];

    expect(paths(expandAlongEdges(scored, files, [], 3))).toEqual(["src/retry.ts"]);
  });

  it("skips an edge pointing outside the loaded candidate set", () => {
    // Past the scan limit, or a file with no recognised source extension. Expansion may
    // only choose among files it was given — it cannot conjure a row to fetch.
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];
    const edges = [link("src/retry.ts", "vendor/not-loaded.ts")];

    expect(paths(expandAlongEdges(scored, files, edges, 3))).toEqual(["src/retry.ts"]);
  });

  it("skips a neighbour with no recognised source language", () => {
    const scored: ScoredFile[] = [{ ...file("src/retry.ts"), score: 30 }];
    const pool = [file("src/retry.ts"), file("README.md", { language: null })];

    const result = expandAlongEdges(scored, pool, [link("src/retry.ts", "README.md")], 3);

    expect(paths(result)).toEqual(["src/retry.ts"]);
  });
});

describe("fallbackFiles with edges", () => {
  const pool = [
    file("index.ts"),
    file("src/engine.ts"),
    file("src/helper.ts"),
    file("big-root-file.ts", { size: 9000 }),
    file("another-root.ts", { size: 8000 }),
  ];

  it("ranks what the entry point imports above the depth-ordered guess", () => {
    // The behaviour change that matters. Without edges the two root files win on
    // "shallow and large"; with them, the code the entry point actually runs does.
    const edges = [link("index.ts", "src/engine.ts")];

    const result = fallbackFiles(pool, ["index.ts"], 3, edges);

    expect(paths(result)).toEqual(["index.ts", "src/engine.ts", "big-root-file.ts"]);
  });

  it("keeps the previous ordering when no graph exists", () => {
    // Byte-for-byte the old behaviour, so a repository without edges is unaffected by
    // this change rather than merely similar.
    const withEdges = fallbackFiles(pool, ["index.ts"], 3, []);
    const withoutArgument = fallbackFiles(pool, ["index.ts"], 3);

    expect(paths(withEdges)).toEqual(["index.ts", "big-root-file.ts", "another-root.ts"]);
    expect(paths(withoutArgument)).toEqual(paths(withEdges));
  });

  it("still honours the file cap", () => {
    const edges = [link("index.ts", "src/engine.ts"), link("index.ts", "src/helper.ts")];

    expect(fallbackFiles(pool, ["index.ts"], 2, edges)).toHaveLength(2);
  });

  it("never returns a file with no recognised language", () => {
    // fallbackFiles runs on the vaguest questions, where a root-level README would
    // otherwise outrank nested source. Edges must not reintroduce that.
    const withReadme = [...pool, file("README.md", { language: null })];
    const edges = [link("index.ts", "README.md")];

    const result = fallbackFiles(withReadme, ["index.ts"], 3, edges);

    expect(paths(result)).not.toContain("README.md");
  });

  it("expands from entry points even when they are not the first thing scored", () => {
    // Guards the seeding rule itself: on this path the seeds are entry points, not
    // score order, because there are no scores.
    const edges = [link("index.ts", "src/engine.ts")];

    const result = fallbackFiles(pool, ["index.ts"], 3, edges);

    expect(paths(result)[1]).toBe("src/engine.ts");
  });
});

describe("the two paths together", () => {
  it("uses scoring when it works and the graph only to widen it", () => {
    // End-to-end through the real scorer, so the interaction is exercised rather than
    // assumed: a question naming a file scores it, and its import comes along behind.
    const pool = [
      file("src/retry.ts", { symbols: ["retryRequest"] }),
      file("src/backoff.ts", { symbols: ["computeDelay"] }),
      file("src/unrelated.ts", { symbols: ["formatDate"] }),
    ];

    const scored = scoreFiles(pool, "how does retry work");
    expect(paths(scored)[0]).toBe("src/retry.ts");

    const expanded = expandAlongEdges(scored, pool, [link("src/retry.ts", "src/backoff.ts")], 3);

    expect(paths(expanded)[0]).toBe("src/retry.ts");
    expect(paths(expanded)).toContain("src/backoff.ts");
  });
});
