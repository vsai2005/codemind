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
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: "conv_1", userId: "user-1", summary: null, projectId: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: "msg_1" }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    artifact: { create: vi.fn().mockResolvedValue({ id: "art_1" }) },
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops)
    ),
  },
}));

const generateText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    streamText: vi.fn(),
    generateText: (...a: unknown[]) => generateText(...a),
  };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * The verification gate, exercised through the REAL route.
 *
 * A unit test of verifyArtifact proves the checks work. It cannot prove the thing that
 * matters operationally: that a failing report actually stops the write. The gate is
 * only worth anything if `prisma.artifact.create` is never reached — so these tests
 * assert on that call rather than on a return value, because a future refactor could
 * keep the report perfectly correct and persist the artifact anyway.
 */

/** Wording that routes the turn to artifact generation rather than the chat stream. */
const ZIP_PROMPT = "Generate a downloadable zip project for a todo app with react";

function artifactRequest(): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: ZIP_PROMPT }],
      conversationId: "conv_1",
    }),
  });
}

/** Model output in the artifact wire format. */
function zipOutput(files: Record<string, string>): string {
  const blocks = Object.entries(files)
    .map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
    .join("\n");
  return `<codemind_summary>Here is your project.</codemind_summary>\n<codemind_artifact type="zip" name="todo.zip">\n${blocks}\n</codemind_artifact>`;
}

/** Coherent project: nothing for any check to complain about. */
const COHERENT = {
  "package.json": JSON.stringify({ name: "todo", dependencies: { react: "^18.0.0" } }),
  "src/index.ts": `import React from "react";\nimport { store } from "./store";\nexport const app = () => store(React);`,
  "src/store.ts": `export function store(x: unknown) {\n  return x;\n}`,
};

/** Same project, with an import of a file the model never wrote. */
const INCOHERENT = {
  ...COHERENT,
  "src/index.ts": `import React from "react";\nimport { store } from "./store/persist";\nexport const app = () => store(React);`,
};

/** Coherent, but declaring a dependency nothing imports — warning territory. */
const WITH_WARNING = {
  ...COHERENT,
  "package.json": JSON.stringify({
    name: "todo",
    dependencies: { react: "^18.0.0" },
    devDependencies: { eslint: "^9.0.0" },
  }),
};

const artifactWrites = () => vi.mocked(prisma.artifact.create).mock.calls;

const assistantText = (): string => {
  const write = vi
    .mocked(prisma.message.create)
    .mock.calls.find((c: unknown[]) => (c[0] as { data?: { role?: string } })?.data?.role === "assistant");
  return ((write?.[0] as { data: { content: string } })?.data?.content ?? "") as string;
};

describe("artifact verification gate", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    process.env.NVIDIA_API_KEY = "nvapi-testkeytestkeytestkeytestkey";
    __resetRateLimits();
    __resetScheduler();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_API_KEY;
  });

  it("does not persist an artifact whose verification found errors", async () => {
    generateText.mockResolvedValue({
      text: zipOutput(INCOHERENT),
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 200 },
    });

    const res = await POST(artifactRequest());
    await res.text();

    // The whole point of the gate.
    expect(artifactWrites()).toHaveLength(0);
  });

  it("tells the user what failed instead of failing silently", async () => {
    generateText.mockResolvedValue({
      text: zipOutput(INCOHERENT),
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 200 },
    });

    const res = await POST(artifactRequest());
    await res.text();

    // The turn is still written — losing the user's message alongside the failure
    // would be a second, worse bug — and the reply names the concrete problem rather
    // than saying something generic went wrong.
    const text = assistantText();
    expect(text).toMatch(/no complete project artifact/i);
    expect(text).toContain("./store/persist");
  });

  it("persists a clean artifact, so the gate is not simply rejecting everything", async () => {
    // Without this, every assertion above would still pass if verification rejected
    // all input — the failure mode that makes a gate worse than no gate.
    generateText.mockResolvedValue({
      text: zipOutput(COHERENT),
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 200 },
    });

    const res = await POST(artifactRequest());
    await res.text();

    expect(artifactWrites()).toHaveLength(1);
  });

  it("stores the verification report alongside the artifact", async () => {
    generateText.mockResolvedValue({
      text: zipOutput(COHERENT),
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 200 },
    });

    const res = await POST(artifactRequest());
    await res.text();

    const stored = (artifactWrites()[0]?.[0] as { data: { verification: unknown } }).data
      .verification as { ok: boolean; checks: Array<{ status: string }>; version: number };

    expect(stored.ok).toBe(true);
    expect(stored.version).toBe(1);
    // Every check recorded, including its status — a stored report that only listed
    // findings could not distinguish a clean run from a run that checked nothing.
    expect(stored.checks).toHaveLength(4);
    expect(stored.checks.every((c) => c.status === "passed")).toBe(true);
  });

  it("does not block on warnings, and surfaces them to the user", async () => {
    generateText.mockResolvedValue({
      text: zipOutput(WITH_WARNING),
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 200 },
    });

    const res = await POST(artifactRequest());
    await res.text();

    // Not blocked.
    expect(artifactWrites()).toHaveLength(1);

    // And not swallowed: a warning that only ever reached a log would be
    // indistinguishable from one that was never raised.
    const text = assistantText();
    expect(text).toContain("eslint");
    expect(text).toMatch(/block the download/i);

    const stored = (artifactWrites()[0]?.[0] as { data: { verification: unknown } }).data
      .verification as { ok: boolean; warnings: unknown[] };
    expect(stored.ok).toBe(true);
    expect(stored.warnings).toHaveLength(1);
  });
});
