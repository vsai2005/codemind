import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

/**
 * A conversation store that enforces the one thing under test: `updateMany` only
 * matches when every field in the where clause matches, INCLUDING summaryVersion.
 *
 * Modelled rather than stubbed, because a mock that ignores the version filter would
 * make the race tests pass no matter what the route does.
 */
vi.mock("@/lib/db", () => {
  const conversations: any[] = [];
  const messages: any[] = [];
  let seq = 0;

  const prisma: any = {
    __conversations: conversations,
    __messages: messages,
    __reset: () => {
      conversations.length = 0;
      messages.length = 0;
      seq = 0;
    },
    conversation: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `conv_${++seq}`, summary: null, summaryVersion: 0, projectId: null, ...data };
        conversations.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        conversations.find((c) => c.id === where.id && c.userId === where.userId) ?? null
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matched = conversations.filter((c) => {
          if (c.id !== where.id) return false;
          if (where.userId !== undefined && c.userId !== where.userId) return false;
          // The whole point: a stale version matches nothing.
          if (where.summaryVersion !== undefined && c.summaryVersion !== where.summaryVersion) {
            return false;
          }
          return true;
        });
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
      delete: vi.fn(async () => ({})),
    },
    message: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `msg_${++seq}`, createdAt: new Date(), ...data };
        messages.push(row);
        return row;
      }),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = messages.find((m) => m.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
      findMany: vi.fn(async () => []),
    },
    artifact: { create: vi.fn(async () => ({ id: "art_1" })) },
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops)
    ),
  };

  return { prisma };
});

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { streamText, generateText } from "ai";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { SUMMARY_MAX_CHARS } from "@/lib/ai/summarization";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

const db = prisma as any;

/** Distinguishes the summarizer call from the planner; both use generateText. */
const SUMMARY_MARKER = "conversation memory manager";
const BULK = "A".repeat(3000);

function conversationRequest(id: string): Request {
  const history = Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: BULK,
  }));
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [...history, { role: "user", content: `So what did we decide? ${Math.random()}` }],
      conversationId: id,
    }),
  });
}

/** Route generateText: planner gets junk (so no plan), summarizer gets `summaryText`. */
function summarizerReturns(summaryText: string | (() => Promise<string>)): void {
  vi.mocked(generateText).mockImplementation((async (options: any) => {
    const prompt = typeof options?.prompt === "string" ? options.prompt : "";
    if (prompt.includes(SUMMARY_MARKER)) {
      const text = typeof summaryText === "function" ? await summaryText() : summaryText;
      return { text, finishReason: "stop" };
    }
    return { text: "", finishReason: "stop" };
  }) as never);
}

/**
 * Mirrors the AI SDK contract: the stream controller is not closed until onFinish
 * resolves. Summarization is detached inside onFinish, so the returned promise lets a
 * test wait for it without re-coupling it to the stream.
 */
function streamCompletes(): { drained: () => Promise<void> } {
  vi.mocked(streamText).mockImplementation(((options: any) => ({
    toDataStreamResponse: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('0:"hi"\n'));
            await options.onFinish?.({ text: "hi", usage: undefined });
            controller.close();
          },
        })
      ),
  })) as never);
  return { drained: async () => undefined };
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/** Summarization is detached, so give the microtask queue a chance to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function seedConversation(id: string, summary: string | null, version: number): void {
  db.__conversations.push({
    id,
    userId: "user-1",
    projectId: null,
    summary,
    summaryVersion: version,
  });
}

describe("conversation summarization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.__reset();
    __resetRateLimits();
    process.env.CODEMIND_DISABLE_RATE_LIMIT = "true";
    process.env.NVIDIA_API_KEY_1 = "test-key-not-real";
    // Small enough that the bulk history overflows and turns actually get dropped.
    process.env.AI_CONTEXT_MAX_TOKENS = "6000";
    process.env.AI_MAX_OUTPUT_TOKENS = "512";
    __resetScheduler();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    streamCompletes();
  });

  afterEach(() => {
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
    delete process.env.NVIDIA_API_KEY_1;
    delete process.env.AI_CONTEXT_MAX_TOKENS;
    delete process.env.AI_MAX_OUTPUT_TOKENS;
    __resetScheduler();
  });

  it("actually reaches the summarizer, so the rest of this file is not vacuous", async () => {
    // summarizeDropped returns on its first line when nothing was dropped. If the
    // budget stops overflowing, every assertion below would pass for the wrong reason.
    seedConversation("conv_x", null, 0);
    summarizerReturns("A clean prose summary of what was decided.");

    const res = await POST(conversationRequest("conv_x"));
    await drain(res.body);
    await settle();

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining(SUMMARY_MARKER) })
    );
  });

  describe("a valid summary is persisted", () => {
    it("writes the summary and increments the version", async () => {
      seedConversation("conv_x", null, 0);
      summarizerReturns("The team chose PostgreSQL with Prisma and check migrations into the repo.");

      const res = await POST(conversationRequest("conv_x"));
      await drain(res.body);
      await settle();

      const conv = db.__conversations.find((c: any) => c.id === "conv_x");
      expect(conv.summary).toContain("PostgreSQL with Prisma");
      expect(conv.summaryVersion).toBe(1);
    });
  });

  describe("the lost-update race", () => {
    it("lets one write win and discards the loser without throwing", async () => {
      seedConversation("conv_x", null, 0);

      // Both turns read version 0. The first summary to finish takes the version to 1;
      // the second is still holding 0 and must match nothing.
      // Initialised rather than left null: TypeScript cannot see the assignment made
      // inside a Promise executor, so it narrows the variable to never at the call.
      let release: () => void = () => undefined;
      const firstBlocked = new Promise<void>((resolve) => {
        release = resolve;
      });

      let call = 0;
      summarizerReturns(async () => {
        call++;
        if (call === 1) {
          await firstBlocked;
          return "SLOW SUMMARY from the turn that read version 0 first.";
        }
        return "FAST SUMMARY that commits while the other is still generating.";
      });

      const slow = POST(conversationRequest("conv_x")).then(async (res) => {
        await drain(res.body);
      });
      await settle();

      const fast = POST(conversationRequest("conv_x")).then(async (res) => {
        await drain(res.body);
      });
      await settle();

      release();
      await Promise.all([slow, fast]);
      await settle();

      const conv = db.__conversations.find((c: any) => c.id === "conv_x");

      // Exactly one write landed, and it is intact rather than a blend of the two.
      expect(conv.summaryVersion).toBe(1);
      expect(conv.summary).toContain("FAST SUMMARY");
      expect(conv.summary).not.toContain("SLOW SUMMARY");

      // The loser was logged, not thrown.
      expect(logger.info).toHaveBeenCalledWith(
        "Discarded a summary that lost the version race",
        expect.objectContaining({ conversationId: "conv_x", expectedVersion: 0 })
      );
    });
  });

  describe("output validation", () => {
    it("rejects a summary containing tool-call syntax", async () => {
      seedConversation("conv_x", "PRIOR SUMMARY", 3);
      summarizerReturns('The user asked for a file so I will {"tool": "write_file", "arguments": {}}');

      const res = await POST(conversationRequest("conv_x"));
      await drain(res.body);
      await settle();

      const conv = db.__conversations.find((c: any) => c.id === "conv_x");
      // The previous summary stands; nothing was overwritten.
      expect(conv.summary).toBe("PRIOR SUMMARY");
      expect(conv.summaryVersion).toBe(3);
      expect(logger.warn).toHaveBeenCalledWith(
        "Rejected a generated conversation summary",
        expect.objectContaining({ reason: expect.stringContaining("tool-call") })
      );
    });

    it("rejects a summary containing artifact markup", async () => {
      seedConversation("conv_x", "PRIOR SUMMARY", 1);
      summarizerReturns(
        'Decisions so far.\n<codemind_artifact type="zip" name="x.zip">\n<file path="a.ts">x</file>\n</codemind_artifact>'
      );

      const res = await POST(conversationRequest("conv_x"));
      await drain(res.body);
      await settle();

      const conv = db.__conversations.find((c: any) => c.id === "conv_x");
      expect(conv.summary).toBe("PRIOR SUMMARY");
      expect(conv.summaryVersion).toBe(1);
    });

    it("rejects an over-length summary", async () => {
      seedConversation("conv_x", "PRIOR SUMMARY", 2);
      summarizerReturns("x".repeat(SUMMARY_MAX_CHARS + 1));

      const res = await POST(conversationRequest("conv_x"));
      await drain(res.body);
      await settle();

      const conv = db.__conversations.find((c: any) => c.id === "conv_x");
      expect(conv.summary).toBe("PRIOR SUMMARY");
      expect(logger.warn).toHaveBeenCalledWith(
        "Rejected a generated conversation summary",
        expect.objectContaining({ reason: expect.stringContaining("cap") })
      );
    });

    it("rejects an empty summary rather than erasing memory", async () => {
      // The pre-existing behaviour wrote whatever came back, so one empty generation
      // wiped the conversation's entire memory.
      seedConversation("conv_x", "PRIOR SUMMARY", 5);
      summarizerReturns("   \n  ");

      const res = await POST(conversationRequest("conv_x"));
      await drain(res.body);
      await settle();

      const conv = db.__conversations.find((c: any) => c.id === "conv_x");
      expect(conv.summary).toBe("PRIOR SUMMARY");
      expect(conv.summaryVersion).toBe(5);
    });
  });

  describe("failures stay non-fatal to the turn", () => {
    it("returns the reply normally when the summarizer throws", async () => {
      seedConversation("conv_x", "PRIOR SUMMARY", 1);
      vi.mocked(generateText).mockImplementation((async (options: any) => {
        const prompt = typeof options?.prompt === "string" ? options.prompt : "";
        if (prompt.includes(SUMMARY_MARKER)) throw new Error("provider exploded");
        return { text: "", finishReason: "stop" };
      }) as never);

      const res = await POST(conversationRequest("conv_x"));
      await expect(drain(res.body)).resolves.toBeUndefined();
      await settle();

      expect(res.status).toBe(200);
      const conv = db.__conversations.find((c: any) => c.id === "conv_x");
      expect(conv.summary).toBe("PRIOR SUMMARY");
      expect(logger.warn).toHaveBeenCalledWith(
        "Background summarization failed",
        expect.objectContaining({ conversationId: "conv_x" })
      );
    });
  });
});
