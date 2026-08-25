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

    it("keeps the grounding layer inside its budget", () => {
      expect(estimateTokens(layers.grounding)).toBeLessThanOrEqual(LAYER_TOKEN_BUDGETS.grounding);
    });

    it("keeps the output contract inside its budget", () => {
      // The floor every turn pays, so growth here is the most expensive kind.
      expect(estimateTokens(layers.outputContract)).toBeLessThanOrEqual(
        LAYER_TOKEN_BUDGETS.outputContract
      );
    });

    it("keeps the artifact rules inside their budget", () => {
      expect(estimateTokens(layers.artifactRules)).toBeLessThanOrEqual(
        LAYER_TOKEN_BUDGETS.artifactRules
      );
    });

    it("keeps the assembled static layers inside the context-manager reserve", () => {
      // Must stay in step with SYSTEM_PROMPT_RESERVE in lib/ai/context-manager.ts.
      expect(estimateTokens(buildSystemPrompt())).toBeLessThanOrEqual(STATIC_PROMPT_TOKEN_BUDGET);
      expect(STATIC_PROMPT_TOKEN_BUDGET).toBe(520);
    });
  });

  /**
   * Pre-rewrite lock-in.
   *
   * These exist so a restructure of the prompt is provably non-regressive: they were
   * written and passing against the CURRENT prompt, so a change that breaks one is
   * reporting a behaviour change rather than a stylistic edit.
   */
  describe("load-bearing behaviour (locked in before any rewrite)", () => {
    it("always identifies as CodeMind, whatever context is attached", () => {
      for (const blocks of ["", "\n\n--- PROJECT INSTRUCTIONS ---\nBe terse.", "\n\n--- REPOSITORY FILES ---\n=== a.ts ===\nx"]) {
        expect(buildSystemPrompt({ contextBlocks: blocks })).toContain("You are CodeMind");
      }
    });

    it("forbids tool-call JSON by shape, not just by name", () => {
      // The exact shapes the model actually emitted in the incident that produced
      // chat-output-guard.ts. Naming the concept alone was tried and was not enough.
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('{"tool": ...}');
      expect(prompt).toContain('{"name": ..., "arguments": ...}');
    });

    it("holds all three download failure modes at once", () => {
      // Each of these was introduced by fixing the previous one; the prompt regressed
      // twice by satisfying one and breaking another, so they are asserted together.
      const prompt = buildSystemPrompt();
      expect(prompt).toMatch(/codemind can produce downloads/i); // not a refusal
      expect(prompt).toMatch(/never say a download cannot be created/i);
      expect(prompt).toMatch(/never say a download is being created/i); // not a false promise
      expect(prompt).not.toMatch(/you cannot .{0,20}create a file/i);
    });

    /**
     * The budgeting model in context-manager charges the static layers to
     * SYSTEM_PROMPT_RESERVE and the context blocks to the conversation budget, as if
     * the two were additive. estimateTokens is density-aware, so they are NOT:
     * measured drift reaches +225 tokens on a large dense-code context.
     *
     * That drift is absorbed by SAFETY_MARGIN_RATIO (2% — at least 2,560 tokens for
     * any realistic window), which is why it has never surfaced. This test pins the
     * relationship down so it stays true: the drift is PROPORTIONAL to block size, so
     * it belongs in the safety margin and must not be "fixed" by inflating the
     * constant reserve.
     */
    it("keeps additive-accounting drift within the safety margin", () => {
      const staticOnly = estimateTokens(buildSystemPrompt());

      // Deliberately the worst shape found by sweeping: large, dense, punctuation-heavy.
      const dense = 'export function x(a: string): Record<string, unknown> { return { a, b: [1,2,3] }; }\n'.repeat(128);
      const blocks = `\n\n--- REPOSITORY FILES ---\n=== src/x.ts ===\n${dense}`;

      const whole = estimateTokens(buildSystemPrompt({ contextBlocks: blocks }));
      const parts = staticOnly + estimateTokens(blocks);
      const drift = whole - parts;

      // The smallest safety margin any realistic window produces (2% of 128k).
      const SMALLEST_REALISTIC_MARGIN = Math.ceil(128_000 * 0.02);
      expect(drift).toBeLessThan(SMALLEST_REALISTIC_MARGIN);
    });

    /**
     * The fail-safe default, and the reason it falls this way.
     *
     * A caller that passes nothing must still get the artifact rules. Omitting them
     * reproduces a failure mode that has already regressed twice, so the default has
     * to be the safe one and only an explicit `false` may drop them.
     */
    it("includes the artifact rules unless a caller explicitly opts out", () => {
      const bare = buildSystemPrompt(); // no options at all
      expect(bare).toContain("<codemind_artifact>");
      expect(bare).toMatch(/never say a download is being created/i);
    });
  });

  /**
   * The anti-hallucination contract.
   *
   * Repository grounding is CodeMind's core product promise and was previously
   * enforced by nothing — not the prompt, and not chat-output-guard.ts, which is
   * scoped to bare tool-call syntax and explicitly declines to pattern-match prose.
   * These were `todo` during the audit; they are the acceptance criteria for the work
   * that added the layer.
   */
  describe("repository grounding contract", () => {
    const grounded = () =>
      buildSystemPrompt({
        hasRepositoryContext: true,
        contextBlocks: "\n\n--- REPOSITORY FILES ---\n=== src/a.ts ===\nexport const a = 1;",
      });

    it("instructs the model to cite only file paths present in contextBlocks", () => {
      expect(grounded()).toMatch(/cite a path only if it appears above/i);
    });

    it("instructs the model to say 'not in the provided context' rather than invent a symbol", () => {
      const prompt = grounded();
      expect(prompt).toContain("that is not in the provided context");
      // The escalation half: a named gap is what a future context-expansion loop reads.
      expect(prompt).toMatch(/name the file or symbol you would need/i);
    });

    it("forbids claiming to have read a file that was not supplied", () => {
      expect(grounded()).toMatch(/never say you opened, read or searched anything/i);
    });

    it("includes the grounding block ONLY when repository files are attached", () => {
      expect(grounded()).toContain("not in the provided context");
    });

    it("omits the grounding block entirely when no repository is attached", () => {
      // Grounding rules that point at an absent REPOSITORY FILES block invite the
      // model to explain it has no files instead of answering the question asked.
      const noRepo = buildSystemPrompt({ contextBlocks: "\n\n--- PROJECT MEMORY ---\nUses Prisma." });
      expect(noRepo).not.toContain("not in the provided context");
      expect(noRepo).not.toMatch(/cite a path only/i);
    });

    it("keeps the grounding rules after the context they refer to", () => {
      const prompt = grounded();
      expect(prompt.indexOf("Cite a path only")).toBeGreaterThan(
        prompt.indexOf("--- REPOSITORY FILES ---")
      );
    });
  });

  /**
   * Conditional assembly. The saving this restructure exists for, asserted rather
   * than asserted-about.
   */
  describe("conditional assembly", () => {
    it("drops the artifact rules when the caller reports no file mention", () => {
      const plain = buildSystemPrompt({ includeArtifactRules: false });
      expect(plain).not.toContain("<codemind_artifact>");
      expect(plain).not.toMatch(/never say a download/i);
    });

    it("keeps the tool-call prohibition even then", () => {
      // The one rule that can never be conditional: the model invented a tool during
      // an ordinary request, so no signal would have predicted it.
      const plain = buildSystemPrompt({ includeArtifactRules: false });
      expect(plain).toContain('{"tool": ...}');
      expect(plain).toMatch(/never emit tool-call or function-call syntax/i);
    });

    it("costs a plain chat turn materially less than the old unconditional prompt", () => {
      // The old prompt was 377 tokens on EVERY turn, artifact rules included.
      const plain = estimateTokens(buildSystemPrompt({ includeArtifactRules: false }));
      expect(plain).toBeLessThan(260);
    });

    it("keeps even the worst case inside the reserve", () => {
      // Repo attached AND a file mentioned — everything on at once, which is what
      // SYSTEM_PROMPT_RESERVE has to be sized for.
      const worst = estimateTokens(
        buildSystemPrompt({ hasRepositoryContext: true, includeArtifactRules: true })
      );
      expect(worst).toBeLessThanOrEqual(STATIC_PROMPT_TOKEN_BUDGET);
      expect(STATIC_PROMPT_TOKEN_BUDGET).toBe(520);
    });
  });
});
