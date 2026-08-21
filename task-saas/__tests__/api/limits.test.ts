import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    conversation: {
      create: vi.fn().mockResolvedValue({ id: "conv_1", userId: "user-1", summary: null }),
      findFirst: vi.fn().mockResolvedValue({ id: "conv_1", userId: "user-1", summary: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: "msg_1" }),
      // Historical retrieval candidates, loaded server-side.
      findMany: vi.fn().mockResolvedValue([]),
    },
    artifact: { create: vi.fn().mockResolvedValue({ id: "art_1" }) },
  },
}));

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    streamText: vi.fn().mockImplementation(() => ({
      toDataStreamResponse: () => new Response("mock_stream"),
    })),
    generateText: vi.fn().mockResolvedValue({ text: "", finishReason: "stop" }),
  };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { streamText } from "ai";
import { MAX_MESSAGE_CHARS } from "@/types/chat";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

function chatRequest(payload: unknown): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Text long enough to be interesting, with no artifact-intent keywords. */
function filler(length: number): string {
  return "A".repeat(length);
}

describe("Chat request size handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimits();
    // Rate limits would otherwise trip partway through these loops.
    process.env.CODEMIND_DISABLE_RATE_LIMIT = "true";
    // The route resolves a model before generating, and the registry refuses a model
    // whose provider has no credentials. A synthetic key makes NVIDIA "configured";
    // the `ai` module is mocked, so no request is ever made with it.
    process.env.NVIDIA_API_KEY_1 = "test-key-not-real";
    __resetScheduler();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
    delete process.env.AI_CONTEXT_MAX_TOKENS;
    delete process.env.NVIDIA_API_KEY_1;
    __resetScheduler();
  });

  it("forwards messages of varying size to the model intact", async () => {
    for (const length of [10_000, 25_000, 50_000, 100_000]) {
      const res = await POST(
        chatRequest({ messages: [{ role: "user", content: filler(length) }], conversationId: "conv_1" })
      );

      expect(res.status, `length ${length}`).toBe(200);

      const callArgs = vi.mocked(streamText).mock.calls.at(-1)?.[0] as any;
      const sent = callArgs?.messages?.at(-1)?.content;
      expect(sent?.length, `length ${length}`).toBe(length);
    }
  });

  it("rejects a message above the hard character cap with 400", async () => {
    const res = await POST(
      chatRequest({
        messages: [{ role: "user", content: filler(MAX_MESSAGE_CHARS + 1) }],
        conversationId: "conv_1",
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid chat request/);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("rejects a message that exceeds the context budget with 400, not 500", async () => {
    process.env.AI_CONTEXT_MAX_TOKENS = "2000";

    const res = await POST(
      chatRequest({ messages: [{ role: "user", content: filler(150_000) }], conversationId: "conv_1" })
    );

    expect(res.status).toBe(400);
    // V3 surfaces a typed ContextOverflowError explaining the message was NOT truncated.
    const body = await res.json();
    expect(body.error).toMatch(/too large for the model's context window/i);
    expect(body.error).toMatch(/not been truncated/i);
  });

  it("rejects unauthenticated requests before doing any work", async () => {
    (auth as any).mockResolvedValue(null);

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("rejects a structurally invalid body", async () => {
    expect((await POST(chatRequest({ messages: [] }))).status).toBe(400);
    expect((await POST(chatRequest({}))).status).toBe(400);
    expect(
      (await POST(chatRequest({ messages: [{ role: "assistant", content: "hi" }] }))).status
    ).toBe(400);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
  });
});
