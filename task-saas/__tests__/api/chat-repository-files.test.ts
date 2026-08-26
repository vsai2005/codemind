import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    conversation: {
      create: vi.fn().mockResolvedValue({ id: "conv_1", userId: "user-1", summary: null }),
      findFirst: vi.fn().mockResolvedValue({
        id: "conv_1",
        userId: "user-1",
        summary: null,
        summaryVersion: 0,
        projectId: "proj_1",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: "msg_1" }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    /** A project backed by a fully indexed repository — the repo-aware path. */
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: "proj_1",
        instructions: null,
        memory: null,
        repository: {
          id: "repo_1",
          owner: "sindresorhus",
          name: "p-limit",
          commitSha: "df476048d023ff868cd45b35ee47f5fb0ca2b25a",
          status: "ready",
          structure: { entryPoints: ["index.js"] },
        },
      }),
    },
    repositoryFile: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: { create: vi.fn().mockResolvedValue({ id: "art_1" }) },
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops)
    ),
  },
}));

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: vi.fn().mockResolvedValue({ text: "", finishReason: "stop" }),
  };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { streamText } from "ai";
import { prisma } from "@/lib/db";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";
import { fallbackFiles, type IndexedFile } from "@/lib/repo/selection";

/**
 * The repository-file candidate filter, pinned.
 *
 * WHY THIS IS TESTED AT THE QUERY AND NOT THROUGH A RETURN VALUE
 * `loadRepositoryFiles` lives in app/api/chat/route.ts and CANNOT be imported: Next
 * permits only HTTP-method and route-config exports from a route module, which is why
 * the codebase already duplicates schemas rather than sharing them across route files.
 *
 * Mocking `repositoryFile.findMany` to return rows would prove nothing either — the
 * filter under test IS the where clause, so a mock that hands back whatever it likes
 * asserts the mock, not the query. The same trap is recorded elsewhere in this
 * codebase: a field omitted from an explicit `select` is invisible to any test whose
 * mock supplies it anyway.
 *
 * So what is asserted is the ARGUMENT: that the route asks the database to exclude
 * rows with no recognised language. That is the thing that would silently disappear in
 * a refactor, and the thing whose absence has no other guard — see the second test.
 */
function findManyArgs(): any {
  const calls = vi.mocked(prisma.repositoryFile.findMany).mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

function chatRequest(): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "how does this library limit concurrency" }],
      conversationId: "conv_1",
      projectId: "proj_1",
    }),
  });
}

describe("repository file selection candidates", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEY_1 = "test-key";
    __resetRateLimits();
    __resetScheduler();
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(streamText).mockReturnValue({
      toDataStreamResponse: () => new Response("ok", { status: 200 }),
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_API_KEY_1;
  });

  it("asks the database to exclude files with no recognised language", async () => {
    await POST(chatRequest());

    const args = findManyArgs();
    expect(args).not.toBeNull();
    expect(args.where.repositoryId).toBe("repo_1");
    // The filter itself. On the real p-limit ingestion this removed 10 of 16 indexed
    // rows — readme.md, package.json, licence, dotfiles — from ever reaching context.
    expect(args.where).toMatchObject({ NOT: { language: null } });
  });

  it("selects the symbol columns scoring depends on", async () => {
    // symbols/internalSymbols are what let a question about behaviour reach the file
    // implementing it. Dropped from the select, scoring silently degrades to path-only
    // while every unit test that supplies them directly still passes.
    await POST(chatRequest());

    const args = findManyArgs();
    expect(args.select).toMatchObject({
      path: true,
      size: true,
      language: true,
      symbols: true,
      internalSymbols: true,
    });
  });

  /**
   * THE QUERY IS NO LONGER THE ONLY GUARD — and this asserts the redundancy, not just
   * the clause above.
   *
   * It used to be. `fallbackFiles` runs precisely when scoring finds nothing, so on the
   * vaguest questions, and orders by depth and size — a root-level README outranked
   * code nested under source/. Handed an unfiltered list it returned the README, and
   * this test previously asserted exactly that, recording the exposure.
   *
   * `isSelectableSource` in lib/repo/selection.ts now refuses null-language rows
   * independently, so dropping the where clause degrades efficiency (the database
   * returns rows that are then discarded) rather than correctness. Both layers are
   * asserted because the point is that either alone would be enough, and neither is
   * relied upon alone.
   */
  it("refuses null-language rows even when the caller does not pre-filter", () => {
    const unfiltered: IndexedFile[] = [
      { path: "readme.md", size: 4972, language: null, symbols: [], internalSymbols: [] },
      { path: "index.js", size: 3315, language: "javascript", symbols: ["pLimit"], internalSymbols: [] },
    ];

    const chosen = fallbackFiles(unfiltered, [], 2);

    expect(chosen.map((c) => c.path)).not.toContain("readme.md");
    expect(chosen.map((c) => c.path)).toContain("index.js");
  });
});
