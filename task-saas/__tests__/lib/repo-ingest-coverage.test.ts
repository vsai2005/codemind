import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const repositoryUpdate = vi.fn().mockResolvedValue({});
const createMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@/lib/db", () => ({
  prisma: {
    repository: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "repo_1", status: "pending", fileCount: 0, structure: null }),
      update: (...args: unknown[]) => repositoryUpdate(...args),
    },
    repositoryFile: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: (...args: unknown[]) => createMany(...args),
    },
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops)
    ),
  },
}));

const fetchTarball = vi.fn();

vi.mock("@/lib/repo/github", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isGitHubConfigured: () => true,
    fetchRepoMeta: vi.fn().mockResolvedValue({ defaultBranch: "main", commitSha: "abc123" }),
    fetchTree: vi.fn().mockResolvedValue({
      // A pure-Python repository. No JS or TS anywhere, so symbol extraction is not
      // merely unproductive — it never runs.
      entries: [
        { path: "src/parser.py", blobSha: "a", size: 4200 },
        { path: "src/lexer.py", blobSha: "b", size: 3100 },
        { path: "src/__init__.py", blobSha: "c", size: 120 },
        { path: "tests/test_parser.py", blobSha: "d", size: 2400 },
        { path: "pyproject.toml", blobSha: "e", size: 800 },
        { path: "README.md", blobSha: "f", size: 5000 },
      ],
      truncated: false,
    }),
    fetchTarball: (...args: unknown[]) => fetchTarball(...args),
  };
});

import { ingestRepository } from "@/lib/repo/ingest";
import { describeCoverage } from "@/lib/repo/structure";

/**
 * The REAL ingestion path on a repository the extractor does not support.
 *
 * A sibling suite asserts the coverage shape and its wording. This one exists because
 * that suite recomputes the arithmetic to build its fixtures, so it would keep passing
 * even if ingestRepository counted wrongly. Here the counts come from ingestRepository
 * itself, read back off the row it writes.
 */
function writtenStructure(): Record<string, unknown> {
  const readyWrite = repositoryUpdate.mock.calls.find(
    (c: any) => c[0]?.data?.status === "ready"
  );
  return readyWrite?.[0]?.data?.structure as Record<string, unknown>;
}

describe("ingesting a repository with no JS/TS", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test";
  });

  afterEach(() => {
    vi.clearAllMocks();
    repositoryUpdate.mockResolvedValue({});
    createMany.mockResolvedValue({ count: 0 });
    delete process.env.GITHUB_TOKEN;
  });

  it("still reaches ready — an unsupported language is not a failure", () => {
    return ingestRepository({ owner: "acme", name: "pyproj" }).then((result) => {
      expect(result.ok).toBe(true);
      const write = repositoryUpdate.mock.calls.find((c: any) => c[0]?.data?.status === "ready");
      expect(write).toBeDefined();
      expect(write![0].data.error).toBeNull();
    });
  });

  it("never spends a tarball request it cannot use", async () => {
    // The archive exists to be parsed for symbols. With no supported file in the tree
    // there is nothing to parse, so fetching it would be a request and a download for
    // no result.
    await ingestRepository({ owner: "acme", name: "pyproj" });
    expect(fetchTarball).not.toHaveBeenCalled();
  });

  it("records zero symbol coverage, computed by ingestion itself", async () => {
    const result = await ingestRepository({ owner: "acme", name: "pyproj" });

    expect(result.ok).toBe(true);
    const coverage = (result as { coverage?: Record<string, unknown> }).coverage!;

    expect(coverage.indexedFiles).toBe(6);
    expect(coverage.symbolEligibleFiles).toBe(0);
    expect(coverage.filesWithSymbols).toBe(0);
    expect(coverage.symbolsExtracted).toBe(false);
    expect(coverage.languages).toContain("python");
    expect(coverage.languagesWithoutSymbols).toContain("python");
  });

  it("persists that coverage on the repository row", async () => {
    await ingestRepository({ owner: "acme", name: "pyproj" });

    const structure = writtenStructure();
    expect(structure).toBeDefined();
    // Stored in the existing Json column rather than a new table, and alongside the
    // structure it describes.
    expect(structure.coverage).toMatchObject({
      indexedFiles: 6,
      symbolEligibleFiles: 0,
      filesWithSymbols: 0,
      symbolsExtracted: false,
    });
  });

  it("produces a note the user can act on", async () => {
    const result = await ingestRepository({ owner: "acme", name: "pyproj" });
    const note = describeCoverage((result as { coverage?: never }).coverage);

    expect(note).not.toBeNull();
    expect(note).toMatch(/6 files/);
    expect(note).toMatch(/JavaScript and TypeScript/);
  });

  it("indexes every file, including ones with no recognised language", async () => {
    // The file list stays an honest picture of the repository. What changes is which
    // rows are SELECTABLE later, not which are recorded.
    await ingestRepository({ owner: "acme", name: "pyproj" });

    const rows = createMany.mock.calls[0][0].data as Array<{ path: string; language: string | null }>;
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.path === "README.md")!.language).toBeNull();
    expect(rows.find((r) => r.path === "src/parser.py")!.language).toBe("python");
  });
});
