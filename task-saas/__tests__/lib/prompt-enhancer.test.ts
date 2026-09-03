import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generateText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, generateText: (...a: unknown[]) => generateText(...a) };
});

vi.mock("@/lib/ai/models/registry", () => ({
  resolveModel: () => ({
    model: {} as never,
    descriptor: { id: "ministral-3b" },
    effectiveContextTokens: 1000,
    effectiveOutputTokens: 120,
  }),
}));

import {
  enhancePrompt,
  hasEnhanceableSubject,
  ENHANCER_MAX_OUTPUT_TOKENS,
  ENHANCER_MAX_INPUT_CHARS,
} from "@/lib/ai/prompt-enhancer";

/**
 * The composer's Enhance action.
 *
 * TWO PROPERTIES CARRY THIS FEATURE, and everything below exists to pin one of them:
 *
 * 1. IT NEVER INVENTS A SUBJECT. A draft with nothing to be specific about is refused
 *    in code, before any model is asked. Measured: given that judgment, qwen-2.5-7b
 *    answered "needs clarification" to everything including "write a debounce", and
 *    ministral-3b turned "give pdf" into "PDF file with embedded metadata (author,
 *    title, creation date) extracted and validated for integrity". A rule cannot
 *    fabricate; a model asked to be helpful will.
 *
 * 2. FAILING MEANS UNCHANGED. Every failure returns the user's own words. A rewrite
 *    they did not see happen is worse than no rewrite, because they would send it
 *    believing it was theirs.
 */

const reply = (text: string) => generateText.mockResolvedValue({ text });

beforeEach(() => {
  generateText.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deciding whether there is a subject at all", () => {
  it("refuses a draft that is only a verb and a container", () => {
    /**
     * THE FABRICATION CASE, and the one this feature exists to get right. "give pdf"
     * names a format and nothing to put in it.
     */
    expect(hasEnhanceableSubject("give pdf")).toBe(false);
    expect(hasEnhanceableSubject("pdf")).toBe(false);
    expect(hasEnhanceableSubject("zip please")).toBe(false);
    expect(hasEnhanceableSubject("make app")).toBe(false);
  });

  it("refuses a draft that is only filler", () => {
    expect(hasEnhanceableSubject("fix it")).toBe(false);
    expect(hasEnhanceableSubject("please")).toBe(false);
    expect(hasEnhanceableSubject("can you do this")).toBe(false);
  });

  it("accepts a draft with one real subject", () => {
    /**
     * REGRESSION GUARD from the live run. An earlier version required TWO substantive
     * words and refused "write a debounce" — "write" and "a" are filler, leaving one —
     * even though it is plainly enhanceable and the model rewrote it well.
     */
    expect(hasEnhanceableSubject("write a debounce")).toBe(true);
    expect(hasEnhanceableSubject("parse csv")).toBe(true);
    expect(hasEnhanceableSubject("add retry logic to the api client")).toBe(true);
  });

  it("never asks the model about a subjectless draft", () => {
    // MUTATION GUARD. The point is not the answer, it is that no provider call happens:
    // a model that is never asked cannot invent anything.
    reply("A detailed PDF about metadata validation.");

    return enhancePrompt("give pdf").then((r) => {
      expect(r.status).toBe("needs-clarification");
      expect(generateText).not.toHaveBeenCalled();
    });
  });
});

describe("a successful rewrite", () => {
  it("returns the enhanced text", async () => {
    reply("Write a debounce helper that delays a callback and cancels pending calls.");

    const r = await enhancePrompt("write a debounce");

    expect(r.status).toBe("enhanced");
    expect(r.text).toBe(
      "Write a debounce helper that delays a callback and cancels pending calls."
    );
  });

  it("strips a label the model was told not to add", () => {
    // Measured: ministral-3b emits a "Rewrite:" prefix despite the instruction. Cheaper
    // to strip than to trade away four times better latency for a cleaner talker.
    reply("Rewrite: Parse CSV text into rows, handling quoted fields.");

    return enhancePrompt("parse csv").then((r) => {
      expect(r.text).toBe("Parse CSV text into rows, handling quoted fields.");
    });
  });

  it("asks for a request, not an essay", async () => {
    reply("something longer");
    await enhancePrompt("parse csv");

    expect(generateText.mock.calls[0][0].maxTokens).toBe(120);
    expect(ENHANCER_MAX_OUTPUT_TOKENS).toBe(120);
  });

  it("does not retry under a spinner", async () => {
    // MUTATION GUARD. A retry doubles a wait the user is watching, and the fallback
    // costs them nothing: their own text.
    reply("x y z");
    await enhancePrompt("parse csv");

    expect(generateText.mock.calls[0][0].maxRetries).toBe(0);
  });

  it("passes a deadline so a slow model cannot hang the button", async () => {
    reply("x y z");
    await enhancePrompt("parse csv");

    expect(generateText.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("quotes the draft as data between markers", async () => {
    reply("x y z");
    await enhancePrompt("parse csv");

    expect(String(generateText.mock.calls[0][0].prompt)).toContain("<<<\nparse csv\n>>>");
  });
});

describe("failing closed means unchanged", () => {
  const ORIGINAL = "add retry logic to the api client";

  it("returns the original when the provider throws", async () => {
    generateText.mockRejectedValue(new Error("503"));

    const r = await enhancePrompt(ORIGINAL);

    expect(r.status).toBe("failed");
    expect(r.text).toBe(ORIGINAL);
  });

  it("returns the original when the deadline fires", async () => {
    generateText.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "TimeoutError" })
    );

    const r = await enhancePrompt(ORIGINAL);

    expect(r.status).toBe("failed");
    expect(r.text).toBe(ORIGINAL);
  });

  it("treats an empty answer as a failure, not an enhancement", async () => {
    /**
     * MUTATION GUARD. Returning "" as an enhancement would let the UI offer to replace
     * the draft with nothing, which looks like the button worked and silently destroys
     * what the user wrote.
     */
    reply("   ");

    const r = await enhancePrompt(ORIGINAL);

    expect(r.status).toBe("failed");
    expect(r.text).toBe(ORIGINAL);
  });

  it("treats an unchanged answer as a failure", async () => {
    // Offering the user their own sentence back as a "suggestion" is the most confusing
    // possible success: it appears to work and changes nothing.
    reply(ORIGINAL);

    expect((await enhancePrompt(ORIGINAL)).status).toBe("failed");
  });

  it("never throws, whatever the provider does", async () => {
    generateText.mockRejectedValue("a string, not an Error");

    await expect(enhancePrompt(ORIGINAL)).resolves.toMatchObject({ status: "failed" });
  });

  it("skips a draft already longer than the cap", async () => {
    // 2,001 characters is one past the limit. Literal, so a mutation of the constant
    // does not move the fixture with it.
    const r = await enhancePrompt("x".repeat(2_001));

    expect(r.status).toBe("failed");
    expect(generateText).not.toHaveBeenCalled();
    expect(ENHANCER_MAX_INPUT_CHARS).toBe(2_000);
  });

  it("returns the original text verbatim on every failure path", async () => {
    /**
     * THE PROPERTY THE UI DEPENDS ON. The composer shows `text` when a call fails, so a
     * failure that returned anything other than the user's exact words would put a
     * silent substitution in front of them.
     */
    const messy = "  add retry logic\n  to the api client  ";
    generateText.mockRejectedValue(new Error("nope"));

    expect((await enhancePrompt(messy)).text).toBe(messy);
  });
});
