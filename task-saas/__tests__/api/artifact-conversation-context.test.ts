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
 * Declared with vi.hoisted because vi.mock factories are lifted above ordinary consts,
 * and a plain top-level array is not initialised by the time the factory runs.
 */
const HISTORY = vi.hoisted(() => [
  { id: "m1", role: "user", content: "tell me about rust ownership", createdAt: new Date(1) },
  {
    id: "m2",
    role: "assistant",
    content: "Ownership is Rust's memory model: each value has exactly one owner.",
    createdAt: new Date(2),
  },
]);

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
      findMany: vi.fn().mockResolvedValue(HISTORY),
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
const streamText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    streamText: (...a: unknown[]) => streamText(...a),
    generateText: (...a: unknown[]) => generateText(...a),
  };
});

import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * A follow-up request must carry the subject of the conversation into generation.
 *
 * THE DEFECT. `buildContext` returns the recent window as `messages`, for the chat
 * stream, and everything else as `contextBlocks` — summary, attachments, and turns found
 * by KEYWORD RETRIEVAL. Artifact generation was handed only `contextBlocks`, so
 * "give me in the pdf" arrived with no subject and the generator wrote about PDFs.
 *
 * WHY IT LOOKED INTERMITTENT, which is what made it a bug report rather than an obvious
 * hole: whenever retrieval happened to score the previous turn above zero, the subject
 * arrived anyway and the feature appeared to work. Two live runs of exactly this
 * scenario both logged retrievedMessages=2 and both produced the right document. The
 * failure needs retrieval to miss, which is not something a user can predict.
 *
 * These fixtures REMOVE that rescue: `findUnique` returns null so nothing is retrieved,
 * leaving the recent transcript as the only path the subject can take.
 */

const ARTIFACT_OUTPUT = [
  "<codemind_summary>A short document.</codemind_summary>",
  '<codemind_artifact type="pdf" name="rust-ownership.pdf">',
  "# Rust Ownership",
  "",
  "Each value has exactly one owner.",
  "</codemind_artifact>",
].join("\n");

/** The system prompt generateArtifact actually sent. */
const artifactSystem = (): string => {
  const call = generateText.mock.calls.find((c) =>
    String((c[0] as { system?: string })?.system ?? "").includes("codemind_artifact")
  );
  return String((call?.[0] as { system?: string })?.system ?? "");
};

/**
 * The client sends the WHOLE conversation, and the route reads history from the body
 * (`messages.slice(0, -1)`) rather than the database — the body is never trusted for
 * retrieval, but it is what forms the recent window. A single-message fixture would
 * therefore exercise an empty conversation and prove nothing about a follow-up.
 */
function chatRequest(content: string): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { id: "m1", role: "user", content: "tell me about rust ownership" },
        {
          id: "m2",
          role: "assistant",
          content: "Ownership is Rust's memory model: each value has exactly one owner.",
        },
        { id: "m3", role: "user", content },
      ],
      conversationId: "conv_1",
    }),
  });
}

describe("a follow-up artifact request keeps the conversation's subject", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-testkeytestkeytestkeytestkeytestkey";
    generateText.mockResolvedValue({
      text: ARTIFACT_OUTPUT,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
    });
    streamText.mockReturnValue({
      toDataStreamResponse: () => new Response("ok", { status: 200 }),
    });
    __resetRateLimits();
    __resetScheduler();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("sends the recent turns to the artifact generator", async () => {
    /**
     * THE REGRESSION GUARD. "give me in the pdf" names a format and nothing else; the
     * only place "rust ownership" can come from is the transcript.
     */
    const res = await POST(chatRequest("give me in the pdf"));
    await res.text().catch(() => "");

    const system = artifactSystem();
    expect(system).toContain("CONVERSATION SO FAR");
    expect(system).toContain("tell me about rust ownership");
    expect(system).toContain("each value has exactly one owner");
  });

  it("labels who said what, so a request is not read as an answer", async () => {
    // Roles matter to a generator deciding what to write ABOUT: the user's line is the
    // topic and the assistant's is the material.
    const res = await POST(chatRequest("give me in the pdf"));
    await res.text().catch(() => "");

    expect(artifactSystem()).toMatch(/USER:\s*tell me about rust ownership/);
    expect(artifactSystem()).toMatch(/ASSISTANT:/);
  });

  it("does not depend on keyword retrieval to carry the subject", async () => {
    /**
     * MUTATION GUARD, and the whole reason this file exists. Nothing is retrievable in
     * these fixtures, so a version that only passed `contextBlocks` reaches the
     * generator with no mention of Rust at all — which is exactly the reported bug.
     */
    const res = await POST(chatRequest("give me in the pdf"));
    await res.text().catch(() => "");

    expect(artifactSystem()).toMatch(/rust/i);
  });
});
