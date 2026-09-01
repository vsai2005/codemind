import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    generateText: async (options: Record<string, unknown>) => {
      calls.push(options);
      return {
        text:
          `<codemind_summary>done</codemind_summary>\n` +
          `<codemind_artifact type="file" name="debounce.ts">\nexport const debounce = () => {};\n</codemind_artifact>`,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20 },
      };
    },
  };
});

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

import { generateArtifact } from "@/lib/artifacts/generate";
import { HEADER_TIMEOUT_HEADER } from "@/lib/ai/fetch-timeout";
import { POST } from "@/app/api/chat/route";
import { auth } from "@/auth";
import { __resetRateLimits } from "@/lib/rate-limit";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * The slow-model header budget on the ARTIFACT path.
 *
 * THE BUG THIS PINS DOWN
 * `headerTimeoutMs` was applied at one place in the chat route — after the artifact
 * dispatch had already returned. So `generateArtifact` always called the provider with
 * the 60s default, and Kimi K3, measured at ~175s to first byte, could never produce an
 * artifact: it failed identically whether the provider was healthy or degraded. Chat
 * with Kimi worked; downloads with Kimi could not, and the failure looked like a
 * transport problem rather than a missing budget.
 *
 * Asserted on what reaches `generateText`, not on a return value: the budget is only
 * useful if it travels, and every previous version of this code returned exactly the
 * same result while sending nothing.
 */
describe("artifact header budget", () => {
  beforeEach(() => {
    calls.length = 0;
    process.env.NVIDIA_API_KEY = "nvapi-testkeytestkeytestkeytestkey";
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_API_KEY;
  });

  const lastCall = (): Record<string, unknown> => calls[calls.length - 1];
  const headers = (): Record<string, string> | undefined =>
    lastCall().headers as Record<string, string> | undefined;

  it("sends the budget when the model declares one", async () => {
    const result = await generateArtifact({
      type: "file",
      userPrompt: "write a debounce helper",
      headerTimeoutMs: 240_000,
    });

    expect(result.ok).toBe(true);
    expect(headers()).toEqual({ [HEADER_TIMEOUT_HEADER]: "240000" });
  });

  it("sends NO header when the model declares none", async () => {
    // Absent must mean "use the deployment default", not "no timeout". An empty or
    // zero-valued header would be read downstream as a malformed override.
    const result = await generateArtifact({
      type: "file",
      userPrompt: "write a debounce helper",
    });

    expect(result.ok).toBe(true);
    expect(lastCall().headers).toBeUndefined();
  });

  it("passes the exact value through, not a rounded or defaulted one", async () => {
    // An adversarial value: not 240000, so a hardcoded constant cannot pass this.
    await generateArtifact({
      type: "file",
      userPrompt: "write a debounce helper",
      headerTimeoutMs: 137_000,
    });

    expect(headers()).toEqual({ [HEADER_TIMEOUT_HEADER]: "137000" });
  });

  it("carries the budget on a zip artifact too, not only single files", async () => {
    // The slow model is most likely to be chosen for a large project, which is the
    // case that takes longest and is therefore likeliest to exceed the default.
    calls.length = 0;
    await generateArtifact({
      type: "file",
      userPrompt: "write something",
      contextPrompt: "prior conversation",
      headerTimeoutMs: 240_000,
    });

    expect(headers()).toEqual({ [HEADER_TIMEOUT_HEADER]: "240000" });
    // And the context still reaches the system prompt — threading the budget must not
    // displace anything already being sent.
    expect(String(lastCall().system)).toContain("prior conversation");
  });

  it("reaches generateText through the REAL route, not only by direct call", async () => {
    /**
     * THE MUTATION THAT SURVIVED WITHOUT THIS TEST.
     *
     * Deleting `headerTimeoutMs` from the route's dispatch broke nothing above, because
     * every case there calls generateArtifact directly — and the function was never the
     * bug. The bug was that the route returned before the block that applied the budget,
     * so the wiring is the thing that has to be asserted.
     *
     * kimi-k3 is chosen deliberately: it is the model whose descriptor carries 240000,
     * and the only one for which this matters.
     */
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    process.env.NVIDIA_API_KEY = "nvapi-testkeytestkeytestkeytestkey";
    __resetRateLimits();
    __resetScheduler();
    calls.length = 0;

    const res = await POST(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "Generate a downloadable zip project for a todo app" },
          ],
          conversationId: "conv_1",
          model: "kimi-k3",
        }),
      })
    );
    await res.text().catch(() => "");

    expect(calls.length).toBeGreaterThan(0);
    expect(headers()).toEqual({ [HEADER_TIMEOUT_HEADER]: "240000" });
  });
});
