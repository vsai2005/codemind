import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const { state } = vi.hoisted(() => ({
  state: {
    /** What findUnique returns for the existing snapshot. */
    existing: null as Record<string, unknown> | null,
    /** Set true to make the write transaction fail partway. */
    failTransaction: false,
  },
}));

const repositoryUpdate = vi.fn().mockResolvedValue({});
const repositoryCreate = vi
  .fn()
  .mockResolvedValue({ id: "repo_new", status: "pending", fileCount: 0, structure: null });

const tx = {
  repository: { update: (...a: unknown[]) => repositoryUpdate(...a) },
  repositoryFile: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createManyAndReturn: (args: { data: Array<{ path: string }> }) =>
      Promise.resolve(args.data.map((row) => ({ id: `id:${row.path}`, path: row.path }))),
  },
  fileEdge: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(async () => state.existing),
      create: (...a: unknown[]) => repositoryCreate(...a),
      update: (...a: unknown[]) => repositoryUpdate(...a),
    },
    repositoryFile: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      const result = await (ops as (client: typeof tx) => Promise<unknown>)(tx);
      // Fails AFTER the callback body ran, which is what a commit failure looks like.
      if (state.failTransaction) throw new Error("commit failed");
      return result;
    }),
  },
}));

const fetchTree = vi.fn();
const fetchTarball = vi.fn();

vi.mock("@/lib/repo/github", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isGitHubConfigured: () => true,
    fetchRepoMeta: vi.fn().mockResolvedValue({ defaultBranch: "main", commitSha: "sha-current" }),
    fetchTree: (...a: unknown[]) => fetchTree(...a),
    fetchTarball: (...a: unknown[]) => fetchTarball(...a),
  };
});

vi.mock("@/lib/repo/archive", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readTarball: async (_b: unknown, onEntry: (e: { path: string; content: string }) => void) => {
      onEntry({ path: "src/index.ts", content: `import { a } from "./a";\nexport const x = a;` });
      onEntry({ path: "src/a.ts", content: `export const a = 1;` });
    },
  };
});

import { ingestRepository } from "@/lib/repo/ingest";
import {
  DERIVATION_VERSION,
  DERIVATION_SOURCE_DIGEST,
  DERIVATION_SOURCE_FILES,
  isDerivationCurrent,
} from "@/lib/repo/derivation-version";

/**
 * Snapshot reuse keyed on the derivation version, not the commit alone.
 *
 * THE FAILURE THIS CLOSES
 * Reuse was "same commit, skip everything". Correct while the extractors are fixed, and
 * wrong the moment one improves: a repository indexed before the comment masker kept
 * serving edges built from commented-out code, and nothing marked it stale or would
 * ever have re-derived it.
 *
 * FIXTURES ARE NAMED ADVERSARIALLY. The stale row's version is 0 rather than absent, so
 * a comparison that accidentally tested truthiness rather than currency would pass the
 * wrong case; the unknown row is explicitly null.
 */

const READY = {
  id: "repo_1",
  status: "ready",
  fileCount: 2,
  structure: { entryPoints: ["src/index.ts"] },
};

describe("derivation version", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test";
    state.existing = null;
    state.failTransaction = false;
    fetchTree.mockResolvedValue({
      entries: [
        { path: "src/index.ts", blobSha: "a", size: 40 },
        { path: "src/a.ts", blobSha: "b", size: 20 },
      ],
      truncated: false,
    });
    fetchTarball.mockResolvedValue("stream" as unknown);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  it("reuses when the commit and the version both match", async () => {
    state.existing = { ...READY, derivationVersion: DERIVATION_VERSION };

    const result = await ingestRepository({ owner: "acme", name: "same" });

    expect(result.ok && result.reused).toBe(true);
    // Nothing re-derived: the tree and the archive were never fetched.
    expect(fetchTree).not.toHaveBeenCalled();
    expect(fetchTarball).not.toHaveBeenCalled();
  });

  it("re-derives when the version is OLDER, even though the commit is unchanged", async () => {
    // Zero rather than absent: a truthiness check would treat this as "no version" and
    // reach the right answer for the wrong reason.
    state.existing = { ...READY, derivationVersion: 0 };

    const result = await ingestRepository({ owner: "acme", name: "stale" });

    expect(result.ok && result.reused).toBe(false);
    expect(fetchTree).toHaveBeenCalled();
    expect(fetchTarball).toHaveBeenCalled();
  });

  it("treats an unknown version as stale, never as current", async () => {
    // Every row that predates this column. Treating null as current would make the
    // whole mechanism a no-op exactly on the rows that need it.
    state.existing = { ...READY, derivationVersion: null };

    const result = await ingestRepository({ owner: "acme", name: "unknown" });

    expect(result.ok && result.reused).toBe(false);
    expect(fetchTarball).toHaveBeenCalled();
  });

  it("behaves as before for a new commit", async () => {
    // findUnique is keyed on the commit, so a new commit finds nothing.
    state.existing = null;

    const result = await ingestRepository({ owner: "acme", name: "moved" });

    expect(result.ok && result.reused).toBe(false);
    expect(fetchTarball).toHaveBeenCalled();
  });

  it("stamps the version in the same write as the data it describes", async () => {
    state.existing = { ...READY, derivationVersion: 0 };

    await ingestRepository({ owner: "acme", name: "stamped" });

    const ready = repositoryUpdate.mock.calls.find(
      (c: unknown[]) => (c[0] as { data?: { status?: string } })?.data?.status === "ready"
    );
    expect(ready).toBeDefined();
    expect((ready![0] as { data: { derivationVersion: number } }).data.derivationVersion).toBe(
      DERIVATION_VERSION
    );
  });

  it("does not leave a current stamp over partial data when the write fails", async () => {
    // THE DANGEROUS ONE. A stamp written in its own statement after the rows would
    // survive a failure between the two, leaving a version that says "current" over
    // data that is not — and being trusted forever after, because nothing re-derives a
    // current row. Being inside the transaction is what rules that out.
    state.existing = { ...READY, derivationVersion: 0 };
    state.failTransaction = true;

    const result = await ingestRepository({ owner: "acme", name: "interrupted" });

    expect(result.ok).toBe(false);

    // The only update carrying the new stamp is the one inside the transaction that
    // threw, so nothing outside it ever marked the row current.
    const stampedOutsideTransaction = repositoryUpdate.mock.calls.filter((c: unknown[]) => {
      const data = (c[0] as { data?: Record<string, unknown> })?.data ?? {};
      return data.derivationVersion !== undefined && data.status !== "ready";
    });
    expect(stampedOutsideTransaction).toEqual([]);
  });
});

describe("isDerivationCurrent", () => {
  it("accepts the current version and anything newer", () => {
    expect(isDerivationCurrent(DERIVATION_VERSION)).toBe(true);
    expect(isDerivationCurrent(DERIVATION_VERSION + 1)).toBe(true);
  });

  it("rejects older, null and undefined", () => {
    expect(isDerivationCurrent(DERIVATION_VERSION - 1)).toBe(false);
    expect(isDerivationCurrent(null)).toBe(false);
    expect(isDerivationCurrent(undefined)).toBe(false);
  });
});

describe("the version cannot be silently forgotten", () => {
  it("matches the recorded digest of the derivation modules", () => {
    /**
     * The guard on a hand-incremented constant.
     *
     * A content hash was rejected as the version itself because it cannot tell a
     * behaviour change from a comment edit, and this codebase's comments are long
     * enough that every documentation fix would invalidate every repository. Used as a
     * TRIPWIRE instead, the same property is useful: it forces a human to look.
     *
     * If this fails, decide which happened:
     *   behaviour changed -> bump DERIVATION_VERSION and update the digest
     *   comments moved    -> update the digest alone
     */
    const hash = createHash("sha256");
    for (const file of DERIVATION_SOURCE_FILES) hash.update(readFileSync(file, "utf-8"));
    const actual = hash.digest("hex");

    expect(actual, `Derivation modules changed. Current digest is ${actual}`).toBe(
      DERIVATION_SOURCE_DIGEST
    );
  });
});
