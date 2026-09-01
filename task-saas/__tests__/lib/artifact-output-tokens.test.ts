import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { artifactOutputTokensFor } from "@/lib/ai/models/registry";
import { AI_LIMIT_DEFAULTS, getOutputTokenLimit } from "@/lib/env";

/**
 * The output budget for artifact generation.
 *
 * THE DEFECT THIS PINS DOWN
 * `generateArtifact` sent a flat AI_ARTIFACT_MAX_OUTPUT_TOKENS (16,000 by default)
 * whatever model was answering. Nemotron and Gemini both declare 8,192, so the artifact
 * path asked those models for roughly twice what they advertise, while the chat path
 * clamped correctly. The registry is the authority on what a model can emit and exactly
 * one path was bypassing it.
 *
 * EVERY FIXTURE USES THREE DISTINCT NUMBERS, ON PURPOSE.
 * A fixture where the descriptor ceiling and the env budget are equal returns the same
 * answer under `min` and under `max`, so it cannot tell a correct clamp from a reversed
 * one. It also cannot tell `min(a, b)` from "always return the descriptor" or "always
 * return the env value". So each case below picks a ceiling and a budget that differ,
 * and asserts the specific one that should win — which makes the expected value wrong
 * BY CONSTRUCTION under any of those mutations, not merely different.
 */

const ENV = "AI_ARTIFACT_MAX_OUTPUT_TOKENS";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/** Real ceilings from the registry table, so the fixtures track the shipped models. */
const NEMOTRON_CEILING = 8192;
const KIMI_CEILING = 16_384;

describe("clamping to the model's declared ceiling", () => {
  it("uses the MODEL ceiling when it is below the env budget", () => {
    // Nemotron: 8192 declared, 16000 budgeted. The defect in one line — this returned
    // 16000 before the fix. A reversed clamp returns 16000 and fails here.
    delete process.env[ENV];

    expect(artifactOutputTokensFor(NEMOTRON_CEILING)).toBe(8192);
    expect(AI_LIMIT_DEFAULTS.artifactMaxOutputTokens).toBe(16_000);
  });

  it("uses the ENV budget when the model ceiling is above it", () => {
    // Kimi: 16384 declared, 16000 budgeted. The budget is tighter, so it wins. A
    // mutation that always returns the descriptor returns 16384 and fails here.
    delete process.env[ENV];

    expect(artifactOutputTokensFor(KIMI_CEILING)).toBe(16_000);
  });

  it("takes the tighter of the two whichever side it is on", () => {
    // The pair above, restated as one property with numbers chosen so no single
    // constant satisfies both rows.
    process.env[ENV] = "10000";

    expect(artifactOutputTokensFor(8192)).toBe(8192);
    expect(artifactOutputTokensFor(16_384)).toBe(10_000);
  });
});

describe("what the operator can and cannot do", () => {
  it("lets the env var lower the limit below both defaults", () => {
    // 4000 is under Nemotron's 8192 AND under the 16000 default, so it must win
    // outright. Nothing else in range returns 4000.
    process.env[ENV] = "4000";

    expect(artifactOutputTokensFor(NEMOTRON_CEILING)).toBe(4000);
    expect(artifactOutputTokensFor(KIMI_CEILING)).toBe(4000);
  });

  it("does NOT let the env var raise the limit past a model's ceiling", () => {
    // THE RULE THAT MATTERS. 32000 is the top of AI_LIMIT_BOUNDS, so this is an
    // operator asking for the maximum the configuration allows. The model still says
    // 8192, and the model wins. Without the clamp this returns 32000.
    process.env[ENV] = "32000";

    expect(artifactOutputTokensFor(NEMOTRON_CEILING)).toBe(8192);
    expect(artifactOutputTokensFor(KIMI_CEILING)).toBe(16_384);
  });

  it("still clamps an out-of-range env value through the bounds first", () => {
    // 99999 is above AI_LIMIT_BOUNDS.max (32000), so readLimit clamps it to 32000 and
    // the descriptor then clamps again. Two independent ceilings, both applied.
    process.env[ENV] = "99999";

    expect(artifactOutputTokensFor(NEMOTRON_CEILING)).toBe(8192);
  });
});

describe("no declared ceiling", () => {
  it("falls back to the env budget alone", () => {
    // generateArtifact may use the gateway's default model, which arrives as an opaque
    // LanguageModelV1 with no descriptor. That path keeps its previous behaviour rather
    // than guessing a ceiling for a model it cannot identify.
    process.env[ENV] = "12000";

    expect(artifactOutputTokensFor(undefined)).toBe(12_000);
    expect(artifactOutputTokensFor()).toBe(12_000);
  });

  it("does not treat a zero ceiling as absent", () => {
    // `undefined` means unknown; 0 would be a declared ceiling of zero. Conflating them
    // via a falsy check would let a bad descriptor silently get the full budget.
    process.env[ENV] = "12000";

    expect(artifactOutputTokensFor(0)).toBe(0);
  });
});

describe("the measurement harness's truncation fixture", () => {
  it("honours an env value lowered AFTER the model was resolved", () => {
    // scripts/measure-artifacts.ts resolves its model once at startup, then lowers this
    // variable per case to force truncation deterministically. If the budget were a
    // field captured on ResolvedModel, the 300 would be ignored and the truncation case
    // would silently test nothing. Reading the environment at generation time is what
    // keeps that fixture honest.
    process.env[ENV] = "300";

    expect(artifactOutputTokensFor(NEMOTRON_CEILING)).toBe(300);
    expect(artifactOutputTokensFor(undefined)).toBe(300);
  });
});

describe("the chat path is untouched", () => {
  it("does not let the artifact budget bleed into the chat budget", () => {
    // Two separate variables for two separate paths. If the artifact fix had been made
    // by widening a shared limit, this would move — and ordinary replies would silently
    // get longer, which is the opposite of what the split exists for.
    const before = getOutputTokenLimit();
    process.env[ENV] = "300";

    expect(getOutputTokenLimit()).toBe(before);
    expect(getOutputTokenLimit()).toBe(AI_LIMIT_DEFAULTS.maxOutputTokens);
  });

  it("keeps the chat clamp reading its own variable", () => {
    process.env.AI_MAX_OUTPUT_TOKENS = "5000";
    try {
      expect(getOutputTokenLimit()).toBe(5000);
      // The artifact helper is indifferent to it.
      expect(artifactOutputTokensFor(NEMOTRON_CEILING)).toBe(8192);
    } finally {
      delete process.env.AI_MAX_OUTPUT_TOKENS;
    }
  });
});
