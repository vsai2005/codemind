import { describe, it, expect, afterEach } from "vitest";
import { withReasoningBudget, reasoningEffort } from "@/lib/ai/openrouter-reasoning";

/**
 * Bounding the reasoning pass on OpenRouter.
 *
 * WHY IT EXISTS, measured against z-ai/glm-5.3-flash by calling OpenRouter's HTTP API
 * directly, so nothing was mapped or renamed on the way back:
 *
 *   no reasoning field, max_tokens 2000 -> reasoning_tokens 1999, content 0 chars
 *   no reasoning field, max_tokens 8000 -> reasoning_tokens 8000, content 0 chars
 *   reasoning {effort:"low"}            -> reasoning_tokens    0, content 3366 chars
 *
 * The model spends its whole completion budget thinking and returns an empty string, and
 * a bigger budget is simply eaten too. Disabling is refused by the provider
 * (400 "Reasoning is mandatory for this endpoint"), so constraining it is the only lever.
 *
 * Bodies below are LITERAL JSON, shaped the way the AI SDK writes them.
 */

const body = (o: Record<string, unknown>): RequestInit => ({ body: JSON.stringify(o) });
const parse = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

afterEach(() => {
  delete process.env.OPENROUTER_REASONING_EFFORT;
});

describe("choosing the effort", () => {
  it("defaults to low, which measured zero reasoning tokens", () => {
    expect(reasoningEffort()).toBe("low");
  });

  it("accepts the documented values", () => {
    for (const v of ["low", "medium", "high", "off"]) {
      process.env.OPENROUTER_REASONING_EFFORT = v;
      expect(reasoningEffort()).toBe(v);
    }
  });

  it("falls back to low for anything else", () => {
    // A typo must not silently send an invalid value the provider would 400 on.
    for (const v of ["", "LOWEST", "0", "true", "  "]) {
      process.env.OPENROUTER_REASONING_EFFORT = v;
      expect(reasoningEffort()).toBe("low");
    }
  });

  it("is case- and whitespace-insensitive", () => {
    process.env.OPENROUTER_REASONING_EFFORT = "  HIGH ";

    expect(reasoningEffort()).toBe("high");
  });
});

describe("adding the budget to a request", () => {
  it("injects the effort into a normal completion body", () => {
    const out = parse(withReasoningBudget(body({ model: "z-ai/glm-5.3-flash", max_tokens: 16000 })));

    expect(out.reasoning).toEqual({ effort: "low" });
  });

  it("leaves every other field alone", () => {
    // MUTATION GUARD. Rebuilding the body must not drop what the SDK put there — losing
    // `messages` or `max_tokens` would be a far worse bug than the one being fixed.
    const out = parse(
      withReasoningBudget(
        body({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 16000, stream: false })
      )
    );

    expect(out.model).toBe("m");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out.max_tokens).toBe(16000);
    expect(out.stream).toBe(false);
  });

  it("does not overrule a caller that set reasoning itself", () => {
    const out = parse(withReasoningBudget(body({ model: "m", reasoning: { max_tokens: 512 } })));

    expect(out.reasoning).toEqual({ max_tokens: 512 });
  });

  it("sends nothing when the effort is off", () => {
    /**
     * MUTATION GUARD, and the reason "off" exists: it restores the provider's own
     * behaviour so the measurement above can be reproduced without editing code.
     */
    process.env.OPENROUTER_REASONING_EFFORT = "off";
    const init = body({ model: "m", max_tokens: 100 });

    expect(parse(withReasoningBudget(init)).reasoning).toBeUndefined();
  });
});

describe("failing open rather than corrupting a request", () => {
  /**
   * A request that reaches the provider slightly unoptimised is recoverable. One this
   * function mangled is not, so every shape it does not understand passes through
   * byte-for-byte.
   */
  it("passes through a body that is not JSON", () => {
    const init: RequestInit = { body: "not json at all" };

    expect(withReasoningBudget(init)).toBe(init);
  });

  it("passes through a non-string body", () => {
    const init: RequestInit = { body: new Uint8Array([1, 2, 3]) };

    expect(withReasoningBudget(init)).toBe(init);
  });

  it("passes through an empty or absent body", () => {
    const empty: RequestInit = { body: "" };

    expect(withReasoningBudget(empty)).toBe(empty);
    expect(withReasoningBudget(undefined)).toBeUndefined();
  });

  it("passes through JSON that is not an object", () => {
    // MUTATION GUARD: spreading an array or a null would produce a body the provider
    // cannot read, turning a working request into a 400.
    for (const raw of ["[1,2,3]", "null", '"a string"', "42"]) {
      const init: RequestInit = { body: raw };
      expect(withReasoningBudget(init)).toBe(init);
    }
  });
});
