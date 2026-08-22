import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

// Only `logger` is stubbed. The module also exports redactSecrets, which scrubForLog
// calls on the very error path these tests exercise.
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
    // The route batches the assistant write and the updatedAt bump. Resolving the
    // handed-in operations mirrors what Prisma does without needing a database.
    $transaction: vi.fn((ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops))),
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
import { logger } from "@/lib/logger";
import { NO_CAPACITY_CODE } from "@/lib/ai/gateway";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/** Plain prose: no artifact-intent keywords, so this stays on the streaming path. */
const PROMPT = "Explain how closures work in JavaScript and when they capture scope.";

function chatRequest(content = PROMPT): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content }], conversationId: "conv_1" }),
  });
}

/** Every write that persisted the user's own message. */
function userWrites(): any[] {
  return vi.mocked(prisma.message.create).mock.calls.filter((c: any) => c[0]?.data?.role === "user");
}

/** Every write that persisted an assistant reply. */
function assistantWrites(): any[] {
  return vi
    .mocked(prisma.message.create)
    .mock.calls.filter((c: any) => c[0]?.data?.role === "assistant");
}

/**
 * Drive a successful stream and hand back the onFinish the route registered, so the
 * post-stream persistence can be exercised directly.
 */
function captureOnFinish(): () => (arg: unknown) => Promise<void> {
  let captured: ((arg: unknown) => Promise<void>) | null = null;
  vi.mocked(streamText).mockImplementation((options: any) => {
    captured = options.onFinish;
    return { toDataStreamResponse: () => new Response("mock_stream") } as never;
  });
  return () => {
    if (!captured) throw new Error("onFinish was never registered");
    return captured;
  };
}

describe("chat turn persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimits();
    process.env.CODEMIND_DISABLE_RATE_LIMIT = "true";
    // The registry refuses a model whose provider has no credentials. `ai` is mocked,
    // so this synthetic value never reaches a network call.
    process.env.NVIDIA_API_KEY_1 = "test-key-not-real";
    __resetScheduler();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    vi.mocked(prisma.message.create).mockResolvedValue({ id: "msg_1" } as never);
    vi.mocked(prisma.$transaction).mockImplementation(
      ((ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops))) as never
    );
  });

  afterEach(() => {
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
    delete process.env.NVIDIA_API_KEY_1;
    __resetScheduler();
  });

  /**
   * Each of these returned an error response without ever reaching onFinish, which is
   * where both messages used to be written. The user's own prompt was discarded and
   * came back empty on reload.
   */
  describe("the user message survives every failure between validation and the stream", () => {
    it("persists the user message when the provider reports no capacity", async () => {
      vi.mocked(streamText).mockImplementation(() => {
        throw Object.assign(new Error("upstream busy"), { responseBody: NO_CAPACITY_CODE });
      });

      const res = await POST(chatRequest());

      expect(res.status).toBe(503);
      expect(userWrites()).toHaveLength(1);
      expect(userWrites()[0][0].data.content).toBe(PROMPT);
      // The turn has no reply, and that is the honest record of what happened.
      expect(assistantWrites()).toHaveLength(0);
    });

    it("persists the user message when the provider never sends headers", async () => {
      vi.mocked(streamText).mockImplementation(() => {
        throw new Error("No response headers within 30000ms");
      });

      const res = await POST(chatRequest());

      expect(res.status).toBe(504);
      expect(userWrites()).toHaveLength(1);
      expect(userWrites()[0][0].data.content).toBe(PROMPT);
    });

    it("persists the user message when context is rejected even after the bounded retry", async () => {
      // Both the first attempt and the single reduced-window retry are refused.
      vi.mocked(streamText).mockImplementation(() => {
        throw new Error("This model's maximum context length is 8192 tokens");
      });

      const res = await POST(chatRequest());

      expect(res.status).toBe(400);
      expect(streamText).toHaveBeenCalledTimes(2);
      // Written once, before the first attempt — not once per attempt.
      expect(userWrites()).toHaveLength(1);
    });

    it("writes the user message exactly once on the success path", async () => {
      // The regression the early write could easily introduce: onFinish writing it a
      // second time and every conversation showing the prompt twice.
      const onFinish = captureOnFinish();

      const res = await POST(chatRequest());
      await onFinish()({ text: "Closures capture their defining scope.", usage: undefined });

      expect(res.status).toBe(200);
      expect(userWrites()).toHaveLength(1);
      expect(assistantWrites()).toHaveLength(1);
    });
  });

  describe("onFinish failures are contained", () => {
    it("logs and swallows a persistence failure instead of erroring the stream", async () => {
      const onFinish = captureOnFinish();
      await POST(chatRequest());

      vi.mocked(prisma.$transaction).mockRejectedValue(new Error("deadlock detected") as never);

      // Must resolve. Rejecting here reaches the AI SDK, which calls
      // controller.error() on a stream the user has already read.
      await expect(
        onFinish()({ text: "a reply the user already saw", usage: undefined })
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        "Failed to persist assistant turn",
        expect.objectContaining({ conversationId: "conv_1" })
      );
    });
  });

  describe("token usage", () => {
    it("records usage on the assistant message when the provider reports it", async () => {
      const onFinish = captureOnFinish();
      await POST(chatRequest());

      await onFinish()({
        text: "reply",
        usage: { promptTokens: 1204, completionTokens: 317, totalTokens: 1521 },
      });

      expect(assistantWrites()[0][0].data).toMatchObject({
        promptTokens: 1204,
        completionTokens: 317,
      });
    });

    it("leaves the columns null when the provider reports nothing", async () => {
      const onFinish = captureOnFinish();
      await POST(chatRequest());

      await onFinish()({ text: "reply", usage: undefined });

      expect(assistantWrites()[0][0].data).toMatchObject({
        promptTokens: null,
        completionTokens: null,
      });
    });

    it("stores null rather than NaN, which is what the compatible streaming path yields", async () => {
      // Not hypothetical: @ai-sdk/openai seeds streaming usage with NaN and only
      // replaces it on a usage chunk, which requires stream_options.include_usage —
      // sent only in "strict" compatibility mode. Every adapter here is "compatible".
      // NaN into an Int column is a write error, so this is the realistic case.
      const onFinish = captureOnFinish();
      await POST(chatRequest());

      await onFinish()({
        text: "reply",
        usage: { promptTokens: Number.NaN, completionTokens: Number.NaN, totalTokens: Number.NaN },
      });

      expect(assistantWrites()[0][0].data).toMatchObject({
        promptTokens: null,
        completionTokens: null,
      });
    });
  });

  describe("assistant write and conversation bump", () => {
    it("commits the reply and the updatedAt bump as one transaction", async () => {
      const onFinish = captureOnFinish();
      await POST(chatRequest());

      await onFinish()({ text: "reply", usage: undefined });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // $transaction is overloaded (array form and interactive-callback form), so the
      // recorded argument widens through unknown before narrowing to the array form.
      const batch = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown as unknown[];
      expect(batch).toHaveLength(3);
      // Ownership stays in the where clause the database enforces.
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { id: "conv_1", userId: "user-1" },
        data: { updatedAt: expect.any(Date) },
      });
    });
  });
});
