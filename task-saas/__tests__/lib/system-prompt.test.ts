import { describe, it, expect } from "vitest";
import { estimateTokens } from "@/lib/ai/context-manager";
import {
  buildStaticLayers,
  buildSystemPrompt,
  renderCapabilities,
  renderTaskContext,
  DEFAULT_CAPABILITY_PROFILE,
  LAYER_TOKEN_BUDGETS,
  STATIC_PROMPT_TOKEN_BUDGET,
  type CapabilityProfile,
} from "@/lib/ai/system-prompt";

/**
 * The guardrail *content* is specified by the "system prompt guardrails" block in
 * __tests__/api/context-manager.test.ts, which asserts against the fully assembled
 * prompt and is the contract this refactor had to keep green. This file covers what
 * that block cannot see: layer ordering, capability rendering, and which individual
 * layer blew the token budget.
 */
describe("buildSystemPrompt", () => {
  describe("layer ordering", () => {
    it("places the guardrails last so they outrank the assembled context", () => {
      const prompt = buildSystemPrompt({ contextBlocks: "\n\n--- PROJECT INSTRUCTIONS ---\nBe terse." });

      const identityAt = prompt.indexOf("You are CodeMind");
      const capabilitiesAt = prompt.indexOf("You have NO tools");
      const contextAt = prompt.indexOf("PROJECT INSTRUCTIONS");
      const guardrailsAt = prompt.indexOf("Never emit tool-call");

      expect(identityAt).toBeGreaterThanOrEqual(0);
      expect(capabilitiesAt).toBeGreaterThan(identityAt);
      expect(contextAt).toBeGreaterThan(capabilitiesAt);
      expect(guardrailsAt).toBeGreaterThan(contextAt);
    });

    it("keeps every guardrail after the context, not just the first", () => {
      // A guardrail that drifts above the context loses the end-of-prompt weighting
      // the layering exists to buy.
      const prompt = buildSystemPrompt({ contextBlocks: "\n\n--- PROJECT MEMORY ---\nUses Prisma." });
      const contextAt = prompt.indexOf("PROJECT MEMORY");

      for (const guardrail of [
        "Never emit tool-call",
        "<codemind_artifact>",
        "Never say a download cannot be created",
        "Never say a download is being created",
        "give me this as a PDF",
      ]) {
        expect(prompt.indexOf(guardrail)).toBeGreaterThan(contextAt);
      }
    });

    it("omits the context layer entirely when there is none", () => {
      // Rather than leaving a run of blank lines where the context would have gone.
      expect(buildSystemPrompt()).not.toMatch(/\n{3,}/);
    });
  });

  describe("capability rendering", () => {
    it("renders the no-tools case from the profile, not from hardcoded prose", () => {
      const rendered = renderCapabilities(DEFAULT_CAPABILITY_PROFILE);
      expect(rendered).toMatch(/no tools/i);
      expect(rendered).toMatch(/codemind can produce downloads/i);
    });

    it("names the tools when a profile declares them", () => {
      // Guards the seam the object exists for: when tools are wired up, the prompt
      // follows the profile instead of having to be rewritten by hand.
      const withTools: CapabilityProfile = {
        hasTools: true,
        toolNames: ["read_file", "run_tests"],
        canProduceFiles: true,
        fileMechanism: "artifact-pipeline",
      };
      const rendered = renderCapabilities(withTools);

      expect(rendered).toContain("read_file");
      expect(rendered).toContain("run_tests");
      expect(rendered).not.toMatch(/no tools/i);
    });

    it("never claims the product cannot produce downloads while it can", () => {
      expect(renderCapabilities(DEFAULT_CAPABILITY_PROFILE)).not.toMatch(/cannot produce downloads/i);
    });
  });

  describe("task context layer", () => {
    it("accepts a plan block without disturbing the context blocks", () => {
      // The seam is unused today: planToPromptBlock output is appended to the user
      // message in app/api/chat/route.ts, because the plan is built after context
      // assembly and consumes its output.
      const rendered = renderTaskContext("\n\n--- SUMMARY ---\nx", "\n\n--- IMPLEMENTATION PLAN ---\ny");
      expect(rendered.indexOf("SUMMARY")).toBeLessThan(rendered.indexOf("IMPLEMENTATION PLAN"));
    });

    it("keeps a plan block out of the guardrails", () => {
      const prompt = buildSystemPrompt({
        contextBlocks: "",
        planBlock: "\n\n--- IMPLEMENTATION PLAN ---\nIntent: refactor",
      });
      expect(prompt.indexOf("IMPLEMENTATION PLAN")).toBeLessThan(prompt.indexOf("Never emit tool-call"));
    });
  });

  /**
   * Per-layer ceilings, so an edit that inflates one layer fails a test that names
   * that layer instead of a whole-prompt assertion that only reports a total.
   *
   * Measured individually and NOT summed: estimateTokens picks its divisor from
   * punctuation density, so these three add to more than the assembled prompt scores.
   */
  describe("token budget", () => {
    const layers = buildStaticLayers();

    it("keeps the identity layer inside its budget", () => {
      expect(estimateTokens(layers.identity)).toBeLessThanOrEqual(LAYER_TOKEN_BUDGETS.identity);
    });

    it("keeps the capabilities layer inside its budget", () => {
      expect(estimateTokens(layers.capabilities)).toBeLessThanOrEqual(
        LAYER_TOKEN_BUDGETS.capabilities
      );
    });

    it("keeps the guardrails layer inside its budget", () => {
      expect(estimateTokens(layers.guardrails)).toBeLessThanOrEqual(LAYER_TOKEN_BUDGETS.guardrails);
    });

    it("keeps the assembled static layers inside the context-manager reserve", () => {
      // Must stay in step with SYSTEM_PROMPT_RESERVE in lib/ai/context-manager.ts.
      expect(estimateTokens(buildSystemPrompt())).toBeLessThanOrEqual(STATIC_PROMPT_TOKEN_BUDGET);
      expect(STATIC_PROMPT_TOKEN_BUDGET).toBe(400);
    });
  });
});
