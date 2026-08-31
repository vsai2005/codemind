import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

/**
 * Ingestion when a file's import scan does not finish.
 *
 * The rule this pins down is the OPPOSITE of the verification path's, and deliberately
 * so: on ingestion a partial scan is degraded but harmless, so the edges it did find
 * are kept. What must survive is the knowledge that the list is a floor — dropping the
 * edges would make the graph emptier for no gain, and dropping the FACT would make an
 * incomplete graph indistinguishable from a complete one.
 */
const { FILES, TREE_ENTRIES } = vi.hoisted(() => {
  const FILES: Record<string, string> = {
    "package.json": '{"name":"big"}',
    "src/small.ts": 'import { a } from "./a";\nexport const s = a;',
    "src/a.ts": "export const a = 1;",
  };
  // 205 resolvable imports plus one that sits past the 200-import scan cap.
  const lines: string[] = [];
  for (let i = 0; i < 205; i++) {
    FILES[`src/mod${i}.ts`] = `export const m${i} = ${i};`;
    lines.push(`import { m${i} } from "./mod${i}";`);
  }
  lines.push('import { never } from "./never-generated";');
  FILES["src/huge.ts"] = lines.join("\n");

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

describe("ingestion with an incomplete import scan", () => {
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

  it("keeps the edges a truncated scan did find", async () => {
    const result = await ingestRepository({ owner: "acme", name: "big" });
    expect(result.ok).toBe(true);

    const fromHuge = writtenEdges().filter((e) => e.sourceFileId === "id:src/huge.ts");
    // Not zero, and not all 206 — a floor, which is exactly what a truncated scan is.
    expect(fromHuge.length).toBeGreaterThan(100);
    expect(fromHuge.some((e) => e.specifier === "./never-generated")).toBe(false);
  });

  it("marks the file as incompletely scanned in coverage", async () => {
    const result = await ingestRepository({ owner: "acme", name: "big" });
    const coverage = (result as { coverage?: Record<string, unknown> }).coverage!;

    // The count is what stops a healthy-looking edge total being read as a complete
    // graph. src/small.ts scanned fine, so exactly one file is incomplete.
    expect(coverage.filesWithIncompleteImportScan).toBe(1);
    expect(coverage.importsExtracted).toBe(true);
  });

  it("reports a complete scan for the file that finished", async () => {
    await ingestRepository({ owner: "acme", name: "big" });

    const fromSmall = writtenEdges().filter((e) => e.sourceFileId === "id:src/small.ts");
    expect(fromSmall).toHaveLength(1);
    expect(fromSmall[0].kind).toBe("resolved");
  });
});
