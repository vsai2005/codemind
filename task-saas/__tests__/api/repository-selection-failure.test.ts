import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

// Hoisted with the mock factory: vi.mock runs before ordinary top-level consts, so a
// plain `const logger = ...` above would be read before it is initialised.
const { logger } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, logger };
});

const repositoryFileFindMany = vi.fn();
const fileEdgeFindMany = vi.fn();
const projectFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    conversation: {
      create: vi.fn().mockResolvedValue({ id: "conv_1", userId: "user-1", summary: null }),
      findFirst: vi.fn().mockResolvedValue({
        id: "conv_1",
        userId: "user-1",
        summary: null,
        projectId: "proj_1",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    project: { findFirst: (...a: unknown[]) => projectFindFirst(...a) },
    message: {
      create: vi.fn().mockResolvedValue({ id: "msg_1" }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    repositoryFile: { findMany: (...a: unknown[]) => repositoryFileFindMany(...a) },
    fileEdge: { findMany: (...a: unknown[]) => fileEdgeFindMany(...a) },
    artifact: { create: vi.fn().mockResolvedValue({ id: "art_1" }) },
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops)
    ),
  },
}));

const streamText = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    streamText: (...a: unknown[]) => streamText(...a),
    generateText: vi.fn().mockResolvedValue({ text: "", finishReason: "stop" }),
  };
});

vi.mock("@/lib/repo/github", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isGitHubConfigured: () => true,
    fetchFileContent: vi.fn(async (_ref: unknown, _sha: string, path: string) =>
      `// contents of ${path}\nexport const x = 1;`
    ),
  };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * Repository selection under partial and total failure.
 *
 * THE FAILURE CLASS THIS PINS DOWN
 * Selection used to return `undefined` on any throw, which the caller could not tell
 * apart from "the repository had nothing worth reading". A broken edge query — an
 * optional widening step — therefore cost the model every repository file, and the
 * user got a fluent answer written as though the repository were empty. The system was
 * blind and did not say so.
 *
 * These tests assert the separation: an optional step failing must degrade, and the
 * mandatory step failing must be ANNOUNCED, never silently absorbed.
 */

const INDEXED = [
  { id: "f1", path: "src/index.ts", size: 400, language: "typescript", symbols: ["run"], internalSymbols: [] },
  { id: "f2", path: "src/retry.ts", size: 400, language: "typescript", symbols: ["retry"], internalSymbols: [] },
  { id: "f3", path: "src/http.ts", size: 400, language: "typescript", symbols: ["request"], internalSymbols: [] },
  { id: "f4", path: "src/backoff.ts", size: 400, language: "typescript", symbols: ["delay"], internalSymbols: [] },
];

function projectWith(importsExtracted: boolean) {
  return {
    instructions: null,
    memory: null,
    repository: {
      id: "repo_1",
      owner: "acme",
      name: "demo",
      commitSha: "abc123",
      status: "ready",
      structure: { entryPoints: ["src/index.ts"] },
      importsExtracted,
    },
  };
}

function chatRequest(content: string): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content }], conversationId: "conv_1" }),
  });
}

/** The single "Repository files selected" line, as an object. */
const selectionLog = (): Record<string, unknown> | undefined => {
  const call = logger.debug.mock.calls.find((c) => c[0] === "Repository files selected");
  return call?.[1] as Record<string, unknown> | undefined;
};

/** The system prompt the model was actually given. */
const systemPrompt = (): string =>
  (streamText.mock.calls[0]?.[0] as { system?: string })?.system ?? "";

const QUESTION = "how does retry work in this project";

describe("repository selection failure modes", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    process.env.NVIDIA_API_KEY = "nvapi-testkeytestkeytestkeytestkey";
    projectFindFirst.mockResolvedValue(projectWith(true));
    repositoryFileFindMany.mockResolvedValue(INDEXED);
    fileEdgeFindMany.mockResolvedValue([
      { sourceFileId: "f2", targetFileId: "f4" },
      { sourceFileId: "f3", targetFileId: "f2" },
    ]);
    streamText.mockReturnValue({
      toDataStreamResponse: () => new Response("ok", { status: 200 }),
    });
    __resetRateLimits();
    __resetScheduler();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_API_KEY;
  });

  it("continues with scored files when the edge query throws", async () => {
    // A PARTIAL failure. The widening step is optional; the files already in hand are
    // the larger part of the value and must survive it.
    fileEdgeFindMany.mockRejectedValue(new Error("relation \"FileEdge\" does not exist"));

    const res = await POST(chatRequest(QUESTION));
    await res.text().catch(() => "");

    expect(res.status).toBe(200);
    const log = selectionLog();
    expect(log).toBeDefined();
    expect(log!.fetched).toBeGreaterThan(0);
    // Recorded as a bug report, not as "this repository has no edges".
    expect(log!.graph).toBe("unavailable");
    expect(log!.chosenFromGraph).toBe(0);
  });

  it("tells the model when the repository could not be read at all", async () => {
    // A TOTAL failure. Answering from the conversation alone in the same confident
    // voice is the outcome this rules out.
    repositoryFileFindMany.mockRejectedValue(new Error("connection terminated"));

    const res = await POST(chatRequest(QUESTION));
    await res.text().catch(() => "");

    expect(res.status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).toContain("REPOSITORY CONTEXT UNAVAILABLE");
    expect(prompt).toMatch(/could not be read/i);
    // The instruction that makes the gap reach the user rather than stopping at the
    // prompt: an unread repository must be stated, not quietly worked around.
    expect(prompt).toMatch(/say so plainly/i);
  });

  it("does not claim unavailability when the repository simply had nothing to add", async () => {
    // The distinction that makes the notice worth anything. An empty index is not a
    // failure, and crying failure on it would train the reader to ignore the notice.
    repositoryFileFindMany.mockResolvedValue([]);

    const res = await POST(chatRequest(QUESTION));
    await res.text().catch(() => "");

    expect(systemPrompt()).not.toContain("REPOSITORY CONTEXT UNAVAILABLE");
  });

  it("reports not-indexed, and never queries edges, for a pre-feature snapshot", async () => {
    projectFindFirst.mockResolvedValue(projectWith(false));

    const res = await POST(chatRequest(QUESTION));
    await res.text().catch(() => "");

    expect(fileEdgeFindMany).not.toHaveBeenCalled();
    expect(selectionLog()!.graph).toBe("not-indexed");
    expect(selectionLog()!.chosenFromGraph).toBe(0);
  });

  it("puts a graph file in front of the model when three files already scored", async () => {
    // The acceptance criterion for the whole change, asserted on the SET of files the
    // model received rather than on a count.
    const res = await POST(chatRequest(QUESTION));
    await res.text().catch(() => "");

    const log = selectionLog();
    expect(log!.graph).toBe("contributed");
    expect(log!.chosenFromGraph as number).toBeGreaterThan(0);

    const prompt = systemPrompt();
    expect(prompt).toContain("src/retry.ts");
    // backoff.ts shares no word with the question and can only have arrived by import.
    expect(prompt).toContain("src/backoff.ts");
  });

  it("behaves as before when the repository has no edges", async () => {
    // No regression for a repository whose graph is empty rather than broken.
    fileEdgeFindMany.mockResolvedValue([]);

    const res = await POST(chatRequest(QUESTION));
    await res.text().catch(() => "");

    const log = selectionLog();
    expect(log!.graph).toBe("no-contribution");
    expect(log!.chosenFromGraph).toBe(0);
    expect(log!.fetched).toBeGreaterThan(0);
  });
});
