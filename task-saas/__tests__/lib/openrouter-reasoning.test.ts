import { describe, it, expect, afterEach } from "vitest";
import {
  withReasoningBudget,
  reasoningEffortOverride,
  reasoningMaxTokens,
  DEFAULT_REASONING_MAX_TOKENS,
} from "@/lib/ai/openrouter-reasoning";

/**
 * Bounding the reasoning pass on OpenRouter.
 *
 * WHY IT EXISTS, measured against z-ai/glm-5.3-flash by calling OpenRouter's HTTP API
 * directly, so nothing was mapped or renamed on the way back:
 *
 *   no reasoning field, max_tokens 2000 -> reasoning_tokens 1999, content 0 chars
 *   no reasoning field, max_tokens 8000 -> reasoning_tokens 8000, content 0 chars
 *   reasoning {max_tokens:512}          -> reasoning_tokens    0, content 5154 chars
 *
 * The model spends its whole completion budget thinking and returns an empty string, and
 * a bigger budget is eaten too. Disabling is refused by the provider (400 "Reasoning is
 * mandatory for this endpoint"), so constraining it is the only lever.
 *
 * Bodies below are LITERAL JSON, shaped the way the AI SDK writes them. The 512 is
 * written out rather than read from the constant: a fixture derived from the value it
 * checks moves with a mutation of it and proves nothing.
 */

const body = (o: Record<string, unknown>): RequestInit => ({ body: JSON.stringify(o) });
const parse = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

afterEach(() => {
  delete process.env.OPENROUTER_REASONING_EFFORT;
  delete process.env.OPENROUTER_REASONING_MAX_TOKENS;
});

describe("the lever that ships", () => {
  it("sends a hard token cap by default, not an effort hint", () => {
    /**
     * THE DECISION THIS PINS. Both levers zeroed reasoning_tokens, so the choice was
     * made on the real path: `effort` produced the only run that hit the 180s deadline
     * on single-debounce, and a cap is a number the provider must honour where "low" is
     * a hint each model reads differently.
     */
    const out = parse(withReasoningBudget(body({ model: "z-ai/glm-5.3-flash", max_tokens: 16000 })));

    expect(out.reasoning).toEqual({ max_tokens: 512 });
  });

  it("ships the measured default rather than an arbitrary number", () => {
    expect(DEFAULT_REASONING_MAX_TOKENS).toBe(512);
    expect(reasoningMaxTokens()).toBe(512);
  });

  it("lets the number be overridden", () => {
    process.env.OPENROUTER_REASONING_MAX_TOKENS = "2048";

    expect(reasoningMaxTokens()).toBe(2048);
    expect(parse(withReasoningBudget(body({ model: "m" }))).reasoning).toEqual({
      max_tokens: 2048,
    });
  });

  it("ignores a nonsense cap rather than sending it", () => {
    // A value the provider would reject must not leave this process. Falling back to the
    // measured default keeps a typo from turning into a 400 on every request.
    for (const v of ["0", "-5", "", "lots", "3.7"]) {
      process.env.OPENROUTER_REASONING_MAX_TOKENS = v;
      expect(reasoningMaxTokens()).toBe(512);
    }
  });

  it("rejects a number with trailing rubbish rather than reading the prefix", () => {
    /**
     * MUTATION GUARD for the STRICT parse specifically. `Number.parseInt("1024abc", 10)`
     * is 1024 — a plausible-looking cap assembled from a typo, large enough to clear the
     * floor, so nothing else in this file would notice it shipping.
     */
    process.env.OPENROUTER_REASONING_MAX_TOKENS = "1024abc";

    expect(reasoningMaxTokens()).toBe(512);
  });

  it("rejects a cap too small to hold a thought", () => {
    /**
     * MUTATION GUARD for the FLOOR specifically. "3" parses cleanly under any strategy —
     * it is an integer and it is positive — so only the floor rejects it. A three-token
     * reasoning budget produces the same empty output this module exists to prevent.
     */
    process.env.OPENROUTER_REASONING_MAX_TOKENS = "3";

    expect(reasoningMaxTokens()).toBe(512);
  });
});

describe("the effort escape hatch", () => {
  it("is null unless explicitly set to a recognised value", () => {
    /**
     * MUTATION GUARD, and the distinction the whole default rests on. If "unset"
     * resolved to "low" the way an earlier version did, the measured default could
     * never be reached and the losing lever would ship silently.
     */
    expect(reasoningEffortOverride()).toBeNull();

    for (const v of ["", "LOWEST", "0", "true", "  "]) {
      process.env.OPENROUTER_REASONING_EFFORT = v;
      expect(reasoningEffortOverride()).toBeNull();
    }
  });

  it("replaces the cap when set to an effort", () => {
    process.env.OPENROUTER_REASONING_EFFORT = "high";
    const out = parse(withReasoningBudget(body({ model: "m" })));

    expect(out.reasoning).toEqual({ effort: "high" });
  });

  it("is case- and whitespace-insensitive", () => {
    process.env.OPENROUTER_REASONING_EFFORT = "  HIGH ";

    expect(reasoningEffortOverride()).toBe("high");
  });

  it("sends no reasoning field at all when set to off", () => {
    /**
     * MUTATION GUARD, and the reason "off" exists: it restores the provider's own
     * behaviour so the empty-output failure can be reproduced without editing code.
     */
    process.env.OPENROUTER_REASONING_EFFORT = "off";

    expect(parse(withReasoningBudget(body({ model: "m", max_tokens: 100 }))).reasoning).toBeUndefined();
  });
});

describe("editing the request safely", () => {
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
    const out = parse(withReasoningBudget(body({ model: "m", reasoning: { effort: "high" } })));

    expect(out.reasoning).toEqual({ effort: "high" });
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
