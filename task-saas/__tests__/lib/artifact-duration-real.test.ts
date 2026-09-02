import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The clock inside generateArtifact itself, not a model of it.
 *
 * WHY THIS FILE IS SEPARATE. The boundary tests next door exercise a stand-in with the
 * same shape, which proves the ARITHMETIC but says nothing about where the clock
 * actually sits in generate.ts. Mutation testing caught precisely that gap on the
 * previous fix in this area — a reverted timer left every hand-built fixture passing.
 * These mock the provider call and read the duration back off the real return value.
 */

const PROVIDER_MS = 4_000;

vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    // Burn fake time INSIDE the provider call, and nowhere else. Everything after this
    // — parsing, validation, verification — runs at zero elapsed time, so any duration
    // other than PROVIDER_MS means the clock is bracketing the wrong span.
    await vi.advanceTimersByTimeAsync(PROVIDER_MS);
    return {
      text: '```ts name="debounce.ts"\nexport const debounce = () => {};\n```',
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
    };
  }),
}));

vi.mock("@/lib/ai/gateway", () => ({
  getModel: () => ({ id: "test-model" }),
}));

import { generateArtifact } from "@/lib/artifacts/generate";

describe("generateArtifact's own duration clock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the provider call's elapsed time on success", async () => {
    const result = await generateArtifact({
      type: "file",
      userPrompt: "write a debounce function",
    });

    // Exact, not a range: the mock is the only thing that advances the clock.
    expect(result.generationMs).toBe(PROVIDER_MS);
  });

  it("reports it on failure too", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockImplementationOnce((async () => {
      await vi.advanceTimersByTimeAsync(PROVIDER_MS);
      throw new Error("Too Many Requests");
    }) as never);

    const result = await generateArtifact({
      type: "file",
      userPrompt: "write a debounce function",
    });

    expect(result.ok).toBe(false);
    // The failure case is why the field exists: a fast rejection and a slow deadline
    // carry indistinguishable error strings.
    expect(result.generationMs).toBe(PROVIDER_MS);
    if (!result.ok) expect(result.stage).toBe("generation");
  });

  it("does not report zero for a call that took time", async () => {
    // Kills the simplest mutation of all: dropping the clock and returning 0.
    const result = await generateArtifact({
      type: "file",
      userPrompt: "write a debounce function",
    });

    expect(result.generationMs).toBeGreaterThan(0);
  });
});
