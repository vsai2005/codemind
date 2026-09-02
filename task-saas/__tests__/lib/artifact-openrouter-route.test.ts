import { describe, it, expect } from "vitest";
import { listModels, resolveModel, getModelDescriptor } from "@/lib/ai/models/registry";

/**
 * Nemotron reached through OpenRouter, alongside the direct NVIDIA route.
 *
 * WHY TWO ENTRIES FOR ONE MODEL. On 2026-09-02 NVIDIA's integrate API returned 503 for
 * nemotron-3-ultra while OpenRouter served the same weights in the same minute. A user
 * can only act on that if the route is selectable, so this is two entries by design —
 * and the direct entry must keep working exactly as it did, which is asserted by value
 * below rather than by "it still exists".
 */

describe("the OpenRouter Nemotron route", () => {
  const OR = "nemotron-3-ultra-openrouter";
  const DIRECT = "nemotron-3-ultra";

  it("is registered as a distinct model from the direct route", () => {
    const ids = listModels().map((m) => m.id);

    expect(ids).toContain(OR);
    expect(ids).toContain(DIRECT);
    // Two entries, one model, two routes. Collapsing them would hide exactly the
    // situation that motivated this: one route 503ing while the other served.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sources its limits from OpenRouter, not from the NVIDIA descriptor", () => {
    const or = getModelDescriptor(OR)!;
    const direct = getModelDescriptor(DIRECT)!;

    // The numbers differ in BOTH directions, which is why copying either across would
    // have misdescribed a route.
    expect(or.providerContextTokens).toBe(1_000_000);
    expect(or.maxOutputTokens).toBe(65_536);
    expect(direct.providerContextTokens).toBe(1_048_576);
    expect(direct.maxOutputTokens).toBe(8_192);

    expect(or.providerContextTokens).not.toBe(direct.providerContextTokens);
    expect(or.maxOutputTokens).not.toBe(direct.maxOutputTokens);
  });

  it("carries its own header budget, since 170s against 180s is 5.9% headroom", () => {
    const or = getModelDescriptor(OR)!;

    expect(or.headerTimeoutMs).toBe(240_000);
    // The direct route does NOT get one — it measures a 9s median and a global raise
    // would have loosened its deadline for nothing.
    expect(getModelDescriptor(DIRECT)!.headerTimeoutMs).toBeUndefined();
  });

  it("leaves the direct NVIDIA entry byte-for-byte unchanged", () => {
    // Asserted by value, not by "it still exists": the point of adding a route is that
    // the original keeps working exactly as it did.
    const direct = getModelDescriptor(DIRECT)!;

    expect(direct.displayName).toBe("Nemotron 3 Ultra");
    expect(direct.provider).toBe("nvidia");
    expect(direct.providerLabel).toBe("NVIDIA");
    expect(direct.providerModelId).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(direct.supportsStreaming).toBe(true);
    expect(direct.supportsVision).toBe(false);
    expect(direct.enabled).toBe(true);
  });

  it("uses its own env override, not the one the Inkling entry reads", () => {
    // OPENROUTER_MODEL is already read by the Inkling entry. A second entry sharing it
    // would silently repoint both — which is the exact confusion that left an entry
    // labelled "Inkling Small" serving Nemotron.
    const saved = process.env.OPENROUTER_MODEL;
    const savedNemotron = process.env.OPENROUTER_NEMOTRON_MODEL;
    try {
      process.env.OPENROUTER_MODEL = "someone/else";
      delete process.env.OPENROUTER_NEMOTRON_MODEL;

      expect(getModelDescriptor(OR)!.providerModelId).toBe(
        "nvidia/nemotron-3-ultra-550b-a55b:free"
      );
      expect(getModelDescriptor("inkling-small")!.providerModelId).toBe("someone/else");
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_MODEL;
      else process.env.OPENROUTER_MODEL = saved;
      if (savedNemotron === undefined) delete process.env.OPENROUTER_NEMOTRON_MODEL;
      else process.env.OPENROUTER_NEMOTRON_MODEL = savedNemotron;
    }
  });

  it("resolves when the credential is present and refuses when it is not", () => {
    const saved = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      expect(resolveModel(OR).descriptor.providerModelId).toBe(
        "nvidia/nemotron-3-ultra-550b-a55b:free"
      );

      delete process.env.OPENROUTER_API_KEY;
      expect(() => resolveModel(OR)).toThrow(/not configured/i);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it("clamps the artifact budget to the env limit, not to the 65,536 ceiling", () => {
    const saved = process.env.OPENROUTER_API_KEY;
    try {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      // The chat clamp: min(descriptor, AI_MAX_OUTPUT_TOKENS=16,384). The route's
      // generous 65,536 does not become the operative number.
      expect(resolveModel(OR).effectiveOutputTokens).toBe(16_384);
      // And the context clamp takes the product ceiling, below the route's 1,000,000.
      expect(resolveModel(OR).effectiveContextTokens).toBeLessThanOrEqual(1_000_000);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });
});
