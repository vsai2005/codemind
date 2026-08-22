import { estimateTokens } from "@/lib/ai/context-manager";
import { logger } from "@/lib/logger";

/**
 * System prompt composition.
 *
 * The conversational persona used to be a single hand-written template literal in
 * context-manager.ts. It is split here into four layers, assembled in a fixed order:
 *
 *   1. IDENTITY      static persona. Rarely changes.
 *   2. CAPABILITIES  rendered from a CapabilityProfile, never hand-written prose.
 *   3. TASK CONTEXT  whatever ContextManager assembled for this turn.
 *   4. GUARDRAILS    static, last, highest priority.
 *
 * Later layers win on conflict, which is why GUARDRAILS is last: an instruction at
 * the end of a system prompt is weighted more reliably than one buried mid-prompt.
 * This is a deliberate change from the pre-refactor order, where the persona — and
 * so the guardrails — preceded the assembled context.
 *
 * The guardrail wording is load-bearing. Three failure modes are encoded in it, each
 * produced by fixing the previous one, and the prompt has to hold all three at once:
 *
 *   1. INVENTED TOOL — told nothing about tools, the model streamed
 *      {"tool": "write_code", "arguments": {...}} into a reply, burned its whole
 *      output budget on escaped JSON and truncated mid-string.
 *   2. REFUSAL — told flatly it "cannot create a file", it answered "I can't create
 *      a PDF". True of the model, false of the product: the artifact pipeline does
 *      produce PDFs.
 *   3. FALSE PROMISE — told the pipeline exists, it narrated as though the pipeline
 *      were running: "the server-side pipeline will now package it, you'll receive
 *      the download shortly". Nothing was running and no file ever arrived.
 *
 * The resolution for (3) is the key fact the model cannot otherwise know: intent
 * detection runs in the route BEFORE this model is called. If it is generating a
 * reply at all, the pipeline already decided this was not a download request. It
 * never runs alongside a chat reply.
 *
 * Any edit here should be checked against all three (see the "system prompt
 * guardrails" tests). The prompt only guides; lib/ai/chat-output-guard.ts is the
 * deterministic backstop and is intentionally independent of this file.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * How finished files reach the user. Not prose: a discriminant the renderer maps to
 * wording, so the prompt cannot drift from what the product actually does.
 */
export type FileMechanism = "artifact-pipeline" | "none";

/**
 * What the model can actually do this turn.
 *
 * Deliberately a data object rather than a paragraph. When real tool calling is
 * added, this becomes the single source of truth that both this renderer and the SDK
 * tool schemas read from, so the prompt cannot claim one thing while the tool list
 * says another. Today it is constructed with hasTools: false.
 */
export interface CapabilityProfile {
  hasTools: boolean;
  /** Empty while hasTools is false. Names only; schemas live with the SDK wiring. */
  toolNames: string[];
  canProduceFiles: boolean;
  fileMechanism: FileMechanism;
}

/**
 * The live profile. No tools are wired up, and files are produced by the server-side
 * artifact pipeline rather than by this model.
 */
export const DEFAULT_CAPABILITY_PROFILE: CapabilityProfile = {
  hasTools: false,
  toolNames: [],
  canProduceFiles: true,
  fileMechanism: "artifact-pipeline",
};

// ---------------------------------------------------------------------------
// Per-layer token budgets
// ---------------------------------------------------------------------------

/**
 * Per-layer ceilings, each measured on that layer in isolation.
 *
 * These exist so an edit that inflates one layer fails a test naming that layer,
 * instead of a single whole-prompt assertion that only says "the prompt got too
 * big". Each is the measured size (identity 40, capabilities 71, guardrails 304)
 * plus headroom for rewording.
 *
 * Deliberately NOT summed into the whole-prompt budget. estimateTokens is
 * content-aware: it picks a divisor from punctuation density, so the dense guardrail
 * layer scores higher alone (304) than it does diluted by the prose layers, and the
 * per-layer figures add to 415 while the assembled prompt measures 377. Summing them
 * would assert an invariant the estimator does not actually hold.
 */
export const LAYER_TOKEN_BUDGETS = {
  identity: 55,
  capabilities: 95,
  guardrails: 330,
} as const;

/**
 * Ceiling on layers 1 + 2 + 4 assembled, which is the figure that has to fit the
 * SYSTEM_PROMPT_RESERVE that context-manager subtracts from the window. Layer 3 is
 * charged against the conversation budget instead. Currently measures 377.
 */
export const STATIC_PROMPT_TOKEN_BUDGET = 400;

export type PromptLayerName = keyof typeof LAYER_TOKEN_BUDGETS;

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Layer 1. Static persona. */
export function renderIdentity(): string {
  return `You are CodeMind, a senior software engineer assistant.

Answer clearly and directly. When you show code, use fenced Markdown code blocks with a language tag.`;
}

/**
 * Layer 2. Rendered from the profile so the claim and the wiring cannot diverge.
 *
 * States only what is true of the MODEL and what is true of the PRODUCT, kept
 * separate. The prohibitions that follow from these facts live in the guardrails.
 */
export function renderCapabilities(profile: CapabilityProfile): string {
  const paragraphs: string[] = [];

  if (profile.hasTools && profile.toolNames.length > 0) {
    paragraphs.push(
      `You have these tools available: ${profile.toolNames.join(", ")}. Call them using the mechanism the runtime provides; never describe a call in prose instead of making it.`
    );
  } else {
    paragraphs.push(
      "You have NO tools. No function calling, no code execution, no file system, no shell, no network access."
    );
  }

  if (profile.canProduceFiles && profile.fileMechanism === "artifact-pipeline") {
    // What the MODEL cannot do, separated from what the PRODUCT can. Collapsing the
    // two is what produced the refusal failure mode.
    paragraphs.push(
      "CodeMind can produce downloads — project archives, PDFs and standalone files — but a separate pipeline builds them and decides before you are called. You are not that pipeline."
    );
  } else if (!profile.canProduceFiles) {
    paragraphs.push("CodeMind cannot produce downloads in this configuration.");
  }

  return paragraphs.join("\n\n");
}

/**
 * Layer 3. Whatever ContextManager already assembled — project instructions,
 * retrieved history, rolling summary — plus, optionally, an implementation plan.
 *
 * Not reimplemented here; this layer only positions it. The plan parameter is a seam:
 * planToPromptBlock() output is currently appended to the user message in the chat
 * route, because the plan is built after context assembly and consumes its output.
 * Nothing passes planBlock today.
 */
export function renderTaskContext(contextBlocks: string, planBlock?: string | null): string {
  return [contextBlocks ?? "", planBlock ?? ""].filter((part) => part.trim().length > 0).join("");
}

/** Layer 4. Static, last, highest priority. See the failure modes above. */
export function renderGuardrails(): string {
  return `Never emit tool-call or function-call syntax of any kind — not a JSON object such as {"tool": ...} or {"name": ..., "arguments": ...}, not XML tool tags, not a fenced block written as though it invokes something. Nothing is listening for it, so it produces no result and wastes the reply.

Never emit the artifact pipeline's markup: no <codemind_artifact>, no <file path="...">. Two rules follow, and both matter:

Never say a download cannot be created. It can, and saying otherwise is simply wrong.

Never say a download is being created, is on its way, is being packaged, or will arrive shortly. If you are writing this reply, that pipeline already decided this was not a download request and is not running. No file is coming. Promising one that never appears is worse than not mentioning it.

So: answer the question and put the content in fenced Markdown blocks. If the user seems to want a file, close with one short line inviting them to ask again explicitly — for example "give me this as a PDF" — because that next message is what routes to the pipeline.`;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface BuildSystemPromptOptions {
  /** Layer 3, already assembled and budgeted by ContextManager. */
  contextBlocks?: string;
  /** Layer 3 addition. Unused today; see renderTaskContext. */
  planBlock?: string | null;
  /** Layer 2 input. Defaults to the live profile. */
  capabilities?: CapabilityProfile;
}

/** The static layers on their own, so callers can measure them without a turn. */
export function buildStaticLayers(
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): Record<PromptLayerName, string> {
  return {
    identity: renderIdentity(),
    capabilities: renderCapabilities(profile),
    guardrails: renderGuardrails(),
  };
}

/**
 * Compose the four layers in order. Blank layers are dropped so an absent context
 * block cannot leave a run of empty lines mid-prompt.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const profile = options.capabilities ?? DEFAULT_CAPABILITY_PROFILE;
  const layers = buildStaticLayers(profile);
  const taskContext = renderTaskContext(options.contextBlocks ?? "", options.planBlock);

  const prompt = [layers.identity, layers.capabilities, taskContext, layers.guardrails]
    .map((layer) => layer.trim())
    .filter((layer) => layer.length > 0)
    .join("\n\n");

  // The static layers growing past the reserve silently under-reserves the context
  // budget, which surfaces later as an occasional overflow rather than an obvious
  // error. Tests assert the ceilings; this catches an overrun that reaches runtime.
  // Measured on the assembled static layers, matching how the reserve is spent.
  const staticTokens = estimateTokens(
    [layers.identity, layers.capabilities, layers.guardrails].join("\n\n")
  );

  if (staticTokens > STATIC_PROMPT_TOKEN_BUDGET) {
    logger.warn("System prompt static layers exceeded their token budget", {
      staticTokens,
      budget: STATIC_PROMPT_TOKEN_BUDGET,
      identity: estimateTokens(layers.identity),
      capabilities: estimateTokens(layers.capabilities),
      guardrails: estimateTokens(layers.guardrails),
    });
  }

  return prompt;
}
