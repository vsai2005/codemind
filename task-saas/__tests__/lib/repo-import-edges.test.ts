import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

/**
 * A small fixture repository, as the archive would deliver it.
 *
 * Every resolution rule the pipeline claims to implement appears here exactly once, so
 * the asserted edge set below is a statement about all of them at once:
 *   - extension-less relative      index.ts   -> "./util"
 *   - directory index              index.ts   -> "./helpers"
 *   - tsconfig alias               index.ts   -> "@/lib/db"
 *   - external package             index.ts   -> "react"
 *   - unresolved relative          index.ts   -> "./missing"
 *   - .js specifier, .ts source    util.ts    -> "./helpers/format.js"
 *   - circular pair                a.ts <-> b.ts
 *   - self-import                  loop.ts    -> itself
 */
const { FILES, TREE_ENTRIES } = vi.hoisted(() => {
  const FILES: Record<string, string> = {
    "tsconfig.json": `{
      // aliases, with a comment and a trailing comma to prove the parser tolerates JSONC
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], } },
    }`,
    "src/index.ts": [
      `import React from "react";`,
      `import { util } from "./util";`,
      `import { help } from "./helpers";`,
      `import { db } from "@/lib/db";`,
      `import { nope } from "./missing";`,
    ].join("\n"),
    "src/util.ts": [`import { format } from "./helpers/format.js";`, `export const util = 1;`].join(
      "\n"
    ),
    "src/helpers/index.ts": `export const help = 1;`,
    "src/helpers/format.ts": `export const format = 1;`,
    "lib/db.ts": `export const db = 1;`,
    "src/a.ts": `import { b } from "./b";\nexport const a = 1;`,
    "src/b.ts": `import { a } from "./a";\nexport const b = 1;`,
    "src/loop.ts": `import { loop } from "./loop";\nexport const loop = 1;`,
    "README.md": `# fixture`,
  };
  
  const TREE_ENTRIES = Object.keys(FILES).map((path, i) => ({
    path,
    blobSha: `sha_${i}`,
    size: FILES[path].length,
  }));
  return { FILES, TREE_ENTRIES };
});

const repositoryUpdate = vi.fn().mockResolvedValue({});
const fileEdgeCreateMany = vi.fn().mockResolvedValue({ count: 0 });
const fileDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

/**
 * Ids are assigned by path so the assertions below can name files rather than guess
 * cuids. The real client returns real ids; what matters to this test is that the edge
 * rows point at the right ROWS, which path-shaped ids make legible.
 */
const tx = {
  repository: { update: (...a: unknown[]) => repositoryUpdate(...a) },
  repositoryFile: {
    deleteMany: (...a: unknown[]) => fileDeleteMany(...a),
    createManyAndReturn: (args: { data: Array<{ path: string }> }) =>
      Promise.resolve(args.data.map((row) => ({ id: `id:${row.path}`, path: row.path }))),
  },
  fileEdge: { createMany: (...a: unknown[]) => fileEdgeCreateMany(...a) },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    repository: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockResolvedValue({ id: "repo_1", status: "pending", fileCount: 0, structure: null }),
      update: (...a: unknown[]) => repositoryUpdate(...a),
    },
    repositoryFile: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops)
        ? Promise.all(ops)
        : (ops as (client: typeof tx) => Promise<unknown>)(tx)
    ),
  },
}));

vi.mock("@/lib/repo/github", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isGitHubConfigured: () => true,
    fetchRepoMeta: vi.fn().mockResolvedValue({ defaultBranch: "main", commitSha: "abc123" }),
    fetchTree: vi.fn().mockResolvedValue({ entries: TREE_ENTRIES, truncated: false }),
    fetchTarball: vi.fn().mockResolvedValue("stream" as unknown),
  };
});

/**
 * Stand in for the tar reader by replaying the fixture through the same callback the
 * real one uses. The archive format is another module's tested concern; what this suite
 * needs is that ingestion sees each file's contents exactly once.
 */
const readTarball = vi.fn(
  async (_body: unknown, onEntry: (e: { path: string; content: string }) => void) => {
    for (const [path, content] of Object.entries(FILES)) onEntry({ path, content });
  }
);

vi.mock("@/lib/repo/archive", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readTarball: (...a: unknown[]) => (readTarball as never as Function)(...a) };
});

import { ingestRepository } from "@/lib/repo/ingest";

interface EdgeRow {
  repositoryId: string;
  sourceFileId: string;
  targetFileId: string | null;
  specifier: string;
  kind: string;
}

function writtenEdges(): EdgeRow[] {
  const call = fileEdgeCreateMany.mock.calls[0];
  return (call?.[0]?.data ?? []) as EdgeRow[];
}

/** Compact, comparable form: "source specifier -> target|kind". */
function asTuples(edges: EdgeRow[]): string[] {
  return edges
    .map((e) => {
      const target = e.targetFileId ? e.targetFileId.replace("id:", "") : e.kind.toUpperCase();
      return `${e.sourceFileId.replace("id:", "")} "${e.specifier}" -> ${target}`;
    })
    .sort();
}

describe("import edges, end to end through ingestRepository", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test";
  });

  afterEach(() => {
    vi.clearAllMocks();
    repositoryUpdate.mockResolvedValue({});
    fileEdgeCreateMany.mockResolvedValue({ count: 0 });
    fileDeleteMany.mockResolvedValue({ count: 0 });
    delete process.env.GITHUB_TOKEN;
  });

  it("writes exactly the expected edge set, and nothing else", async () => {
    const result = await ingestRepository({ owner: "acme", name: "fixture" });
    expect(result.ok).toBe(true);

    // The full set, asserted exactly. A looser check — "contains this edge" — would
    // pass while the resolver invented extra edges, and a spurious edge is as wrong as
    // a missing one for anything that later walks this graph.
    expect(asTuples(writtenEdges())).toEqual(
      [
        `src/index.ts "react" -> EXTERNAL`,
        `src/index.ts "./util" -> src/util.ts`,
        `src/index.ts "./helpers" -> src/helpers/index.ts`,
        `src/index.ts "@/lib/db" -> lib/db.ts`,
        `src/index.ts "./missing" -> UNRESOLVED`,
        `src/util.ts "./helpers/format.js" -> src/helpers/format.ts`,
        `src/a.ts "./b" -> src/b.ts`,
        `src/b.ts "./a" -> src/a.ts`,
        `src/loop.ts "./loop" -> src/loop.ts`,
      ].sort()
    );
  });

  it("records an unresolved external with its raw specifier rather than dropping it", async () => {
    await ingestRepository({ owner: "acme", name: "fixture" });

    const react = writtenEdges().find((e) => e.specifier === "react");
    expect(react).toBeDefined();
    expect(react!.kind).toBe("external");
    expect(react!.targetFileId).toBeNull();

    // The distinction that makes the table worth having: "./missing" is a claim about
    // THIS repository that failed, while "react" was never going to point anywhere
    // here. Storing both as one kind would bury the actionable case.
    const missing = writtenEdges().find((e) => e.specifier === "./missing");
    expect(missing!.kind).toBe("unresolved");
    expect(missing!.targetFileId).toBeNull();
  });

  it("scopes every edge to the repository and to a real source row", async () => {
    await ingestRepository({ owner: "acme", name: "fixture" });

    for (const edge of writtenEdges()) {
      expect(edge.repositoryId).toBe("repo_1");
      expect(edge.sourceFileId).toMatch(/^id:/);
    }
  });

  it("clears the previous snapshot's rows, which is what makes re-ingestion idempotent", async () => {
    await ingestRepository({ owner: "acme", name: "fixture" });

    // Edges cascade from RepositoryFile, so deleting the files is what removes the old
    // graph. Combined with the (sourceFileId, specifier) unique index, re-ingesting
    // cannot accumulate duplicates.
    expect(fileDeleteMany).toHaveBeenCalledWith({ where: { repositoryId: "repo_1" } });
  });

  it("produces an identical edge set on a second ingestion", async () => {
    await ingestRepository({ owner: "acme", name: "fixture" });
    const first = asTuples(writtenEdges());

    fileEdgeCreateMany.mockClear();
    await ingestRepository({ owner: "acme", name: "fixture" });
    const second = asTuples(writtenEdges());

    expect(second).toEqual(first);
  });

  it("reads the archive once, not once per file", async () => {
    await ingestRepository({ owner: "acme", name: "fixture" });

    // Symbols and imports come from the SAME pass. A second read would double the
    // download for a repository of any size.
    expect(readTarball).toHaveBeenCalledTimes(1);
  });

  it("reports import coverage that distinguishes parsed-and-none from never-parsed", async () => {
    const result = await ingestRepository({ owner: "acme", name: "fixture" });
    const coverage = (result as { coverage?: Record<string, unknown> }).coverage!;

    expect(coverage.importsExtracted).toBe(true);
    expect(coverage.tsconfigAliasesLoaded).toBe(true);
    expect(coverage.resolvedEdges).toBe(7);
    expect(coverage.externalEdges).toBe(1);
    expect(coverage.unresolvedEdges).toBe(1);
    // README.md is indexed but not import-eligible; tsconfig.json likewise.
    expect(coverage.filesWithImports).toBe(5);
  });

  it("marks the repository row as having had imports extracted", async () => {
    await ingestRepository({ owner: "acme", name: "fixture" });

    const ready = repositoryUpdate.mock.calls.find(
      (c: unknown[]) => (c[0] as { data?: { status?: string } })?.data?.status === "ready"
    );
    expect(ready).toBeDefined();
    expect((ready![0] as { data: { importsExtracted: boolean } }).data.importsExtracted).toBe(true);
  });
});
