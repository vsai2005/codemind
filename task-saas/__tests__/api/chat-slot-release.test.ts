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
    $transaction: vi.fn((ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops))),
  },
}));

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { streamText, generateText } from "ai";
import { __resetRateLimits, acquireGenerationSlot, concurrentGenerationLimit } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * The summarization prompt is the only reliable way to tell the two generateText
 * callers apart: planning also goes through generateText and must still resolve, or
 * the route never reaches the streaming stage at all.
 */
const SUMMARY_PROMPT_MARKER = "conversation memory manager";

/** Large enough that the trimmed history actually overflows the budget below. */
const BULK = "A".repeat(3000);

/**
 * A conversation long enough that ContextManager drops turns, so
 * droppedMessagesContent is non-empty and summarizeDropped does real work. Without
 * this the function returns on its first line and any timing assertion is vacuous.
 */
function longConversationRequest(): Request {
  const history = Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: BULK,
  }));

  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [...history, { role: "user", content: "So what did we decide?" }],
      conversationId: "conv_1",
    }),
  });
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

describe("generation slot is not held by summarization", () => {
  let summarizationStarted = false;
  let summarizationResolved = false;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimits();
    __resetScheduler();
    summarizationStarted = false;
    summarizationResolved = false;

    // NOT disabling rate limiting: acquireGenerationSlot short-circuits when
    // CODEMIND_DISABLE_RATE_LIMIT is set, and the slot pool is the thing under test.
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
    process.env.NVIDIA_API_KEY_1 = "test-key-not-real";
    // Small enough that the bulk history above overflows and turns get dropped.
    process.env.AI_CONTEXT_MAX_TOKENS = "6000";
    process.env.AI_MAX_OUTPUT_TOKENS = "512";
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });

    vi.mocked(generateText).mockImplementation((async (options: any) => {
      const prompt = typeof options?.prompt === "string" ? options.prompt : "";
      if (prompt.includes(SUMMARY_PROMPT_MARKER)) {
        summarizationStarted = true;
        // Never settles: models the slow second model call this change is about.
        return new Promise(() => undefined);
      }
      // Planning. Unparseable on purpose, so buildPlan returns null.
      return { text: "", finishReason: "stop" };
    }) as never);

    // Mirrors the AI SDK contract that makes this bug possible: the stream controller
    // is not closed until onFinish resolves (node_modules/ai/dist/index.js:4448).
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
  });

  afterEach(() => {
    delete process.env.NVIDIA_API_KEY_1;
    delete process.env.AI_CONTEXT_MAX_TOKENS;
    delete process.env.AI_MAX_OUTPUT_TOKENS;
    __resetScheduler();
  });

  it("drops turns, so summarization is genuinely exercised", async () => {
    // Guards the guard: if the budget stops overflowing, the timing test below would
    // pass without summarization ever being reached.
    const res = await POST(longConversationRequest());
    await drain(res.body);

    expect(res.status).toBe(200);
    expect(summarizationStarted).toBe(true);
  });

  it("releases the slot when the stream drains, while summarization is still running", async () => {
    const res = await POST(longConversationRequest());
    expect(res.status).toBe(200);

    // The in-flight request holds one slot; fill the rest of the pool by hand.
    const held = Array.from({ length: concurrentGenerationLimit() - 1 }, () =>
      acquireGenerationSlot("user-1")
    );
    expect(held.every((release) => release !== null)).toBe(true);

    // Pool is now full, which proves the streaming request really is holding one.
    expect(acquireGenerationSlot("user-1")).toBeNull();

    await drain(res.body);

    // Released on drain even though the summary call has not settled, and cannot:
    // before this change the body could not finish until summarization did.
    const afterDrain = acquireGenerationSlot("user-1");
    expect(afterDrain).not.toBeNull();

    expect(summarizationStarted).toBe(true);
    expect(summarizationResolved).toBe(false);

    afterDrain?.();
    held.forEach((release) => release?.());
  });

  it("still starts summarization rather than dropping it to free the slot faster", async () => {
    const res = await POST(longConversationRequest());
    await drain(res.body);

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining(SUMMARY_PROMPT_MARKER) })
    );
  });
});
