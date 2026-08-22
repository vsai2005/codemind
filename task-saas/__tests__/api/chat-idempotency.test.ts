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
 * An in-memory stand-in for the Message table that enforces the ONE thing under test:
 * the unique index on idempotencyKey. Everything else is a plain fake.
 *
 * Modelled rather than mocked away, because a `create` that silently accepts a
 * duplicate key would make every assertion here pass for the wrong reason.
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
        const row = { id: `conv_${++seq}`, summary: null, projectId: null, ...data };
        conversations.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          conversations.find((c) => c.id === where.id && c.userId === where.userId) ?? null
        );
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => ({})),
    },
    message: {
      create: vi.fn(async ({ data }: any) => {
        if (data.idempotencyKey != null) {
          const clash = messages.find((m) => m.idempotencyKey === data.idempotencyKey);
          if (clash) {
            // What Prisma raises on a unique-index violation.
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

function chatRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }], ...body }),
  });
}

function userMessages(): any[] {
  return db.__messages.filter((m: any) => m.role === "user");
}

/** Make streamText succeed, capturing onFinish so a turn can be completed on demand. */
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

/** Make the provider report no capacity, producing the 503 path. */
function streamFails503(): void {
  vi.mocked(streamText).mockImplementation((() => {
    throw Object.assign(new Error("busy"), { responseBody: "codemind_no_capacity" });
  }) as never);
}

describe("chat request idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.__reset();
    __resetRateLimits();
    process.env.CODEMIND_DISABLE_RATE_LIMIT = "true";
    process.env.NVIDIA_API_KEY_1 = "test-key-not-real";
    __resetScheduler();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
    delete process.env.NVIDIA_API_KEY_1;
    __resetScheduler();
  });

  it("does not open a second conversation when a request with no conversationId is repeated", async () => {
    streamFails503();

    const first = await POST(chatRequest({}));
    const second = await POST(chatRequest({}));

    expect(first.status).toBe(503);
    expect(second.status).toBe(409);
    expect(db.__conversations).toHaveLength(1);
    expect(userMessages()).toHaveLength(1);
  });

  it("does not write a second user message when repeated inside an existing conversation", async () => {
    streamFails503();
    db.__conversations.push({ id: "conv_x", userId: "user-1", summary: null, projectId: null });

    await POST(chatRequest({ conversationId: "conv_x" }));
    const second = await POST(chatRequest({ conversationId: "conv_x" }));

    expect(second.status).toBe(409);
    expect(userMessages()).toHaveLength(1);
  });

  it("returns the conversation id on a 503 so a retry can name it", async () => {
    // Without this header the dashboard client never learns the conversation exists
    // and its retry opens another one.
    streamFails503();

    const res = await POST(chatRequest({}));

    expect(res.status).toBe(503);
    expect(res.headers.get("x-conversation-id")).toBe(db.__conversations[0].id);
  });

  it("treats different messages as different turns", async () => {
    // The constraint must not over-match: two genuinely different messages are two
    // turns even back to back.
    streamFails503();
    db.__conversations.push({ id: "conv_x", userId: "user-1", summary: null, projectId: null });

    await POST(chatRequest({ conversationId: "conv_x" }));
    const other = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "A completely unrelated question." }],
        conversationId: "conv_x",
      }),
    });
    await POST(other);

    expect(userMessages()).toHaveLength(2);
  });

  it("keeps two users sending the same text apart", async () => {
    streamFails503();
    db.__conversations.push({ id: "conv_a", userId: "user-1", summary: null, projectId: null });
    db.__conversations.push({ id: "conv_b", userId: "user-2", summary: null, projectId: null });

    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    const a = await POST(chatRequest({ conversationId: "conv_a" }));

    (auth as any).mockResolvedValue({ user: { id: "user-2" } });
    const b = await POST(chatRequest({ conversationId: "conv_b" }));

    // Neither user collides with or is blocked by the other.
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(userMessages()).toHaveLength(2);
    const keys = userMessages().map((m: any) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("honours an explicit client key over the derived one", async () => {
    streamFails503();
    db.__conversations.push({ id: "conv_x", userId: "user-1", summary: null, projectId: null });

    await POST(chatRequest({ conversationId: "conv_x", idempotencyKey: "turn-abc-123" }));
    const second = await POST(
      chatRequest({ conversationId: "conv_x", idempotencyKey: "turn-abc-123" })
    );

    expect(second.status).toBe(409);
    expect(userMessages()).toHaveLength(1);
  });

  describe("a completed turn releases its key", () => {
    it("allows the same message again after the turn finished", async () => {
      // The reason the key is cleared on completion rather than held forever:
      // "continue" twice in one conversation is normal and must not be blocked.
      const onFinish = streamSucceeds();
      db.__conversations.push({ id: "conv_x", userId: "user-1", summary: null, projectId: null });

      const first = await POST(chatRequest({ conversationId: "conv_x" }));
      await onFinish()({ text: "reply", usage: undefined });

      const second = await POST(chatRequest({ conversationId: "conv_x" }));
      await onFinish()({ text: "reply again", usage: undefined });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(userMessages()).toHaveLength(2);
    });

    it("actually clears the key on the persisted message", async () => {
      // Guards the guard: if the key were never cleared, the test above would pass
      // only because the fake forgot to enforce the constraint.
      const onFinish = streamSucceeds();
      db.__conversations.push({ id: "conv_x", userId: "user-1", summary: null, projectId: null });

      await POST(chatRequest({ conversationId: "conv_x" }));
      expect(userMessages()[0].idempotencyKey).toEqual(expect.any(String));

      await onFinish()({ text: "reply", usage: undefined });
      expect(userMessages()[0].idempotencyKey).toBeNull();
    });
  });

  describe("an abandoned turn is resumed, not duplicated", () => {
    it("reuses the original conversation and user message once the live window passes", async () => {
      streamFails503();
      await POST(chatRequest({}));

      // Age the held key past the window in which a request could still be running.
      const held = userMessages()[0];
      held.createdAt = new Date(Date.now() - 5 * 60_000);

      const retry = await POST(chatRequest({}));

      // Generation was attempted again rather than refused...
      expect(retry.status).toBe(503);
      // ...but nothing was duplicated.
      expect(db.__conversations).toHaveLength(1);
      expect(userMessages()).toHaveLength(1);
    });
  });
});
