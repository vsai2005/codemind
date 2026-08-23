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
 * Records the options every releaseOnStreamEnd call receives, while still behaving
 * like the real helper, so the timeout backstop can be asserted without reaching into
 * stream-lifecycle.ts itself.
 */
const lifecycleCalls: any[] = [];
vi.mock("@/lib/ai/stream-lifecycle", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const real = actual.releaseOnStreamEnd as (r: Response, o: unknown) => Response;
  return {
    ...actual,
    releaseOnStreamEnd: vi.fn((response: Response, options: any) => {
      lifecycleCalls.push(options);
      return real(response, options);
    }),
  };
});

/**
 * A message store that enforces the unique idempotencyKey constraint, so a test cannot
 * pass because the fake quietly allowed a duplicate. Mirrors chat-idempotency.test.ts.
 */
vi.mock("@/lib/db", () => {
  const messages: any[] = [];
  const conversations: any[] = [];
  let seq = 0;

  const prisma: any = {
    __messages: messages,
    __conversations: conversations,
    __reset: () => {
      messages.length = 0;
      conversations.length = 0;
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
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => ({})),
    },
    message: {
      create: vi.fn(async ({ data }: any) => {
        if (data.idempotencyKey != null) {
          const clash = messages.find((m) => m.idempotencyKey === data.idempotencyKey);
          if (clash) {
            const { Prisma } = await import("@prisma/client");
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "test",
            });
          }
        }
        const row = { id: `msg_${++seq}`, createdAt: new Date(), ...data };
        messages.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.idempotencyKey == null) return null;
        return messages.find((m) => m.idempotencyKey === where.idempotencyKey) ?? null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = messages.find((m) => m.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matched = messages.filter((m) => m.id === where.id);
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
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

const db = prisma as any;
const PROMPT = "Explain how closures capture scope in JavaScript.";

function chatRequest(): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }], conversationId: "conv_x" }),
  });
}

function userMessages(): any[] {
  return db.__messages.filter((m: any) => m.role === "user");
}

function seedConversation(): void {
  db.__conversations.push({
    id: "conv_x",
    userId: "user-1",
    projectId: null,
    summary: null,
    summaryVersion: 0,
  });
}

/** Provider reports no capacity, producing the 503 path. */
function streamFails503(): void {
  vi.mocked(streamText).mockImplementation((() => {
    throw Object.assign(new Error("busy"), { responseBody: "codemind_no_capacity" });
  }) as never);
}

/** Provider never sends headers, producing the 504 path. */
function streamFails504(): void {
  vi.mocked(streamText).mockImplementation((() => {
    throw new Error("No response headers within 30000ms");
  }) as never);
}

function streamSucceeds(): () => (arg: unknown) => Promise<void> {
  let captured: ((arg: unknown) => Promise<void>) | null = null;
  vi.mocked(streamText).mockImplementation(((options: any) => {
    captured = options.onFinish;
    return { toDataStreamResponse: () => new Response("mock_stream") };
  }) as never);
  return () => {
    if (!captured) throw new Error("onFinish was never registered");
    return captured;
  };
}

describe("generation slot backstop and post-failure retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleCalls.length = 0;
    db.__reset();
    __resetRateLimits();
    process.env.CODEMIND_DISABLE_RATE_LIMIT = "true";
    process.env.NVIDIA_API_KEY_1 = "test-key-not-real";
    __resetScheduler();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    seedConversation();
  });

  afterEach(() => {
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
    delete process.env.NVIDIA_API_KEY_1;
    __resetScheduler();
  });

  describe("the slot cannot be held forever", () => {
    it("gives the streamed response a positive timeout backstop", async () => {
      // Without this the slot is freed only by drain/error/cancel. A client that
      // vanishes without any of those holds one of three slots until the process
      // restarts, and the user gets an instant 429 on every later message.
      const onFinish = streamSucceeds();
      const res = await POST(chatRequest());
      await onFinish()({ text: "hi", usage: undefined });

      expect(res.status).toBe(200);
      expect(lifecycleCalls).toHaveLength(1);
      expect(lifecycleCalls[0].timeoutMs).toBeGreaterThan(0);
      // Must outlast a real generation: an artifact run was measured at 43s.
      expect(lifecycleCalls[0].timeoutMs).toBeGreaterThanOrEqual(60_000);
      expect(typeof lifecycleCalls[0].onTimeout).toBe("function");
    });
  });

  describe("a retry after a failure resumes rather than duplicating", () => {
    it("answers 409 rather than writing a second user message after a 503", async () => {
      // The key stays held after a failure, so an immediate retry of the same text is
      // recognised as the same turn. That is what stops the duplicate — at the cost of
      // telling the user it is "already being processed" when nothing is running. See
      // TURN_KEY_ASSUMED_LIVE_MS; releasing the key here instead was tried and was
      // worse, because the retry then wrote a second copy of the user's message.
      streamFails503();

      const first = await POST(chatRequest());
      expect(first.status).toBe(503);
      expect(userMessages()[0].idempotencyKey).toEqual(expect.any(String));

      const retry = await POST(chatRequest());
      expect(retry.status).toBe(409);
      expect(userMessages()).toHaveLength(1);
    });

    it("answers 409 rather than writing a second user message after a 504", async () => {
      streamFails504();

      const first = await POST(chatRequest());
      expect(first.status).toBe(504);

      const retry = await POST(chatRequest());
      expect(retry.status).toBe(409);
      expect(userMessages()).toHaveLength(1);
    });

    it("resumes the original turn once the live window has passed", async () => {
      streamFails503();
      await POST(chatRequest());

      // Age the held key past the window in which a request could still be running.
      userMessages()[0].createdAt = new Date(Date.now() - 5 * 60_000);

      const retry = await POST(chatRequest());
      // Generation is attempted again rather than refused, and nothing is duplicated.
      expect(retry.status).toBe(503);
      expect(userMessages()).toHaveLength(1);
    });
  });

  describe("the successful path is unchanged", () => {
    it("clears the key when the reply is persisted", async () => {
      const onFinish = streamSucceeds();
      await POST(chatRequest());

      expect(userMessages()[0].idempotencyKey).toEqual(expect.any(String));

      await onFinish()({ text: "reply", usage: undefined });
      expect(userMessages()[0].idempotencyKey).toBeNull();
    });
  });
});
