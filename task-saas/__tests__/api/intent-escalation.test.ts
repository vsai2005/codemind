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
import { prisma } from "@/lib/db";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * THE HYBRID, EXERCISED THROUGH THE REAL ROUTE.
 *
 * Unit tests prove `artifactIntentIsUncertain` picks the right messages and that
 * `classifyArtifactIntentWithModel` reads an answer safely. Neither can prove the thing
 * that decides whether this feature exists in production: that route.ts actually calls
 * the classifier where the rules declined, and actually routes the turn on its answer.
 *
 * So these assert on `prisma.artifact.create` and on whether the classification prompt
 * was ever sent, not on any return value. A refactor could leave both units perfect and
 * never wire them together, and only this file would notice.
 */

/** The classifier's prompt is identifiable by the data markers it quotes into. */
const isClassifierCall = (call: unknown[]): boolean =>
  String((call[0] as { prompt?: string })?.prompt ?? "").includes("<<<MESSAGE");

const classifierCalls = () => generateText.mock.calls.filter(isClassifierCall);

/**
 * A coherent project, so the verification gate has nothing to complain about.
 *
 * The declared type must match the intent under test. An artifact whose type disagrees
 * with what was requested is rejected before it is written, which would make every
 * assertion below fail for a reason that has nothing to do with escalation.
 */
const COHERENT_ZIP = [
  "<codemind_summary>Here is your project.</codemind_summary>",
  '<codemind_artifact type="zip" name="todo.zip">',
  '<file path="package.json">',
  JSON.stringify({ name: "todo", dependencies: { react: "^18.0.0" } }),
  "</file>",
  '<file path="src/index.ts">',
  'import React from "react";',
  'import { store } from "./store";',
  "export const app = () => store(React);",
  "</file>",
  '<file path="src/store.ts">',
  "export function store(x: unknown) {",
  "  return x;",
  "}",
  "</file>",
  "</codemind_artifact>",
].join("\n");

/**
 * Routes each generateText call by what it is: the classification gets `answer`, the
 * artifact generation gets a coherent zip.
 */
function respond(answer: string): void {
  generateText.mockImplementation((...args: unknown[]) => {
    if (isClassifierCall(args)) return Promise.resolve({ text: answer });
    return Promise.resolve({
      text: COHERENT_ZIP,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
    });
  });
}

function chatRequest(content: string): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content }], conversationId: "conv_1" }),
  });
}

const artifactWrites = () => vi.mocked(prisma.artifact.create).mock.calls;

describe("model-backed intent escalation, through the route", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    process.env.NVIDIA_API_KEY = "nvapi-testkeytestkeytestkeytestkey";
    // The shipped default is OFF -- see intentEscalationEnabled for why. These tests
    // are about what happens when an operator turns it on.
    process.env.CODEMIND_INTENT_ESCALATION = "true";
    __resetRateLimits();
    __resetScheduler();
    streamText.mockReturnValue({
      toDataStreamResponse: () => new Response("streamed", { status: 200 }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_API_KEY;
    delete process.env.CODEMIND_INTENT_ESCALATION;
  });

  it("rescues a request the rules missed", async () => {
    /**
     * "can you zip these files" is an unambiguous archive request that the rules
     * decline: the word "zip" is there, but no delivery phrase they recognise. Before
     * the hybrid this reached the chat stream and the user got prose.
     */
    respond("ZIP");

    const res = await POST(chatRequest("can you zip these files"));
    await res.text();

    expect(classifierCalls()).toHaveLength(1);
    expect(artifactWrites()).toHaveLength(1);
  });

  it("leaves the turn as chat when the model says CHAT", async () => {
    respond("CHAT");

    const res = await POST(chatRequest("my teammate sent over a zip yesterday"));
    await res.text();

    expect(classifierCalls()).toHaveLength(1);
    expect(artifactWrites()).toHaveLength(0);
    expect(streamText).toHaveBeenCalled();
  });

  it("does not consult the model when the rules already decided", async () => {
    /**
     * THE ASYMMETRY, asserted where it actually matters. The unit test proves the
     * predicate returns false; this proves the route never pays for the call, so a
     * classified request cannot be delayed OR contradicted by a provider.
     */
    respond("PDF");

    const res = await POST(chatRequest("give me a downloadable zip of the whole project"));
    await res.text();

    expect(classifierCalls()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(1);
  });

  it("does not consult the model for ordinary conversation", async () => {
    respond("PDF");

    const res = await POST(chatRequest("how are you today"));
    await res.text();

    expect(classifierCalls()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
  });

  it("still answers when the classifier fails", async () => {
    /**
     * FAILING CLOSED, END TO END. A provider outage on the classification call must
     * cost the user nothing but the rules' own answer — never their reply.
     */
    generateText.mockImplementation((...args: unknown[]) => {
      if (isClassifierCall(args)) return Promise.reject(new Error("503 from upstream"));
      return Promise.resolve({ text: "unused", finishReason: "stop", usage: {} });
    });

    const res = await POST(chatRequest("can you zip these files"));
    await res.text();

    expect(res.status).toBe(200);
    expect(artifactWrites()).toHaveLength(0);
    expect(streamText).toHaveBeenCalled();
  });

  it("the switch removes the call from the request path", async () => {
    delete process.env.CODEMIND_INTENT_ESCALATION;
    respond("ZIP");

    const res = await POST(chatRequest("can you zip these files"));
    await res.text();

    expect(classifierCalls()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
  });
});
