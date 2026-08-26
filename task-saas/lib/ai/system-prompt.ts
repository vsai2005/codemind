import { estimateTokens } from "@/lib/ai/context-manager";
import { logger } from "@/lib/logger";

/**
 * System prompt composition.
 *
 * The conversational persona used to be a single hand-written template literal in
 * context-manager.ts. It is split here into layers, assembled in a fixed order:
 *
 *   1.  IDENTITY          static persona. Rarely changes.        always
 *   2.  CAPABILITIES      rendered from a CapabilityProfile.     always
 *   3.  TASK CONTEXT      whatever ContextManager assembled.     when non-empty
 *   3b. REPO GROUNDING    how to use the files above.            only with a repo
 *   4a. OUTPUT CONTRACT   the tool-call prohibition.             always
 *   4b. ARTIFACT RULES    download promises and markup.          unless no file hint
 *
 * Later layers win on conflict, which is why every RULE layer sits after the task
 * context: an instruction at the end of a system prompt is weighted more reliably than
 * one buried mid-prompt. This is a deliberate change from the pre-refactor order,
 * where the persona — and so the guardrails — preceded the assembled context.
 *
 * WHY TWO OF THEM ARE CONDITIONAL
 * Every turn used to pay all of it: 377 tokens, including 194 of artifact and download
 * rules on questions that mentioned no file at all. Splitting the trailing block means
 * a plain chat turn now assembles 203. The two conditions default in OPPOSITE
 * directions, and that asymmetry is the safety property — see BuildSystemPromptOptions.
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
 * instead of a single whole-prompt assertion that only says "the prompt got too big".
 *
 * SIZED TIGHT — measured + ~10%, not a round number well clear of reality. They were
 * generous once (artifactRules allowed 230 against a measured 176) and that slack was
 * a real hole: since buildContext began subtracting the MEASURED prompt rather than a
 * fixed reserve, a layer that grew inside its allowance no longer trips anything at
 * all. It just quietly takes the tokens out of the conversation window, which is worse
 * than the fixed reserve it replaced — that at least failed loudly. These ceilings are
 * now the only thing that notices, so they are set close enough to notice.
 *
 * Measured at the time of writing: identity 40, capabilities 71, guardrails 307,
 * grounding 114, outputContract 106, artifactRules 176.
 *
 * Deliberately NOT summed into the whole-prompt budget. estimateTokens is
 * content-aware: it picks a divisor from punctuation density, so a dense layer scores
 * higher alone than it does diluted by the prose layers. Summing them would assert an
 * invariant the estimator does not actually hold.
 */
export const LAYER_TOKEN_BUDGETS = {
  identity: 45,
  capabilities: 78,
  guardrails: 338,
  /** Repository grounding. Only paid when source files are attached. */
  grounding: 126,
  /** The tool-call prohibition. Unconditional, so this is the floor for every turn. */
  outputContract: 117,
  /** Artifact and download rules. Dropped when the user mentions no file at all. */
  artifactRules: 194,
} as const;

/**
 * Ceiling on the static (non-context) layers assembled, which is the figure that has
 * to fit the SYSTEM_PROMPT_RESERVE that context-manager subtracts from the window.
 * The task-context layer is charged against the conversation budget instead.
 *
 * This must cover the WORST case, not the common one. Since the rule layers became
 * conditional the spread is wide — measured: 203 for a plain chat turn, 318 with a
 * repository attached, 380 when a file is mentioned, and 494 for a repo-backed request
 * that also mentions a file. The reserve is a single constant subtracted before
 * anything about the turn is known, so it is sized to that 494 worst case with ~5%
 * headroom for rewording.
 *
 * NOT sized to absorb the additive-accounting drift between this reserve and the
 * conversation budget (measured up to +225 tokens on a large dense-code context).
 * That drift is proportional to context size rather than constant, so a bigger fixed
 * reserve would overcharge every small request and still not cover a large one; it is
 * absorbed by SAFETY_MARGIN_RATIO instead. See the drift test in
 * __tests__/lib/system-prompt.test.ts.
 */
export const STATIC_PROMPT_TOKEN_BUDGET = 520;

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

/**
 * Layer 3b. Repository grounding — included ONLY when source files were attached.
 *
 * CodeMind's product promise is answering from the repository it was given. Nothing
 * enforced that: chat-output-guard.ts is scoped to bare tool-call syntax and
 * deliberately declines to pattern-match prose, so a confidently invented function
 * name reached the user unchallenged.
 *
 * Conditional because the rules are meaningless without a REPOSITORY FILES block to
 * refer to — and worse than meaningless, since telling a model to "cite only the files
 * above" when there are none invites it to explain that it has no files rather than
 * answer the question it was actually asked.
 *
 * The "name what you would need" instruction is chosen for a second reason: it is the
 * exact input an adaptive context-expansion loop would consume. Building that loop
 * later needs no prompt change, only a reader for output this already produces.
 */
export function renderRepositoryGrounding(): string {
  return `The repository files above are all you can see of it. The repository is larger; the rest was not retrieved.

Cite a path only if it appears above. Never describe a file's contents unless they were shown, and never say you opened, read or searched anything.

If answering needs code you were not given, say "that is not in the provided context" and name the file or symbol you would need. A precise gap is useful; a confident guess about unseen code is not.`;
}

/**
 * Layer 4a. The output contract. ALWAYS included — this one is unconditional.
 *
 * The tool-call prohibition cannot be made conditional on anything: the model invented
 * a tool during an ordinary request, so there is no signal that would have predicted
 * it. chat-output-guard.ts is the deterministic backstop, but it only fires AFTER
 * generation — by then the output budget is already spent and the user gets a notice
 * instead of an answer. This rule is what prevents the waste; the guard only contains
 * it.
 */
export function renderOutputContract(): string {
  return `Never emit tool-call or function-call syntax of any kind — not a JSON object such as {"tool": ...} or {"name": ..., "arguments": ...}, not XML tool tags, not a fenced block written as though it invokes something. Nothing is listening for it, so it produces no result and wastes the reply.

Answer the question and put code in fenced Markdown blocks with a language tag.`;
}

/**
 * Layer 4b. Artifact and download rules — included when the user might be thinking
 * about a file. See the three failure modes in the module header.
 *
 * Conditional, but FAIL-SAFE: `buildSystemPrompt` includes this unless a caller
 * explicitly says not to. The signal is `mentionsFileDelivery`, which is deliberately
 * over-inclusive — see the note there on why a false negative here is far more
 * expensive than a false positive.
 */
export function renderArtifactRules(): string {
  return `Never emit the artifact pipeline's markup: no <codemind_artifact>, no <file path="...">. Two rules follow, and both matter:

Never say a download cannot be created. It can, and saying otherwise is simply wrong.

Never say a download is being created, is on its way, is being packaged, or will arrive shortly. If you are writing this reply, that pipeline already decided this was not a download request and is not running. No file is coming. Promising one that never appears is worse than not mentioning it.

If the user seems to want a file, close with one short line inviting them to ask again explicitly — for example "give me this as a PDF" — because that next message is what routes to the pipeline.`;
}

/**
 * Both trailing rule layers, in order. Retained under the original name so existing
 * callers and tests that reason about "the guardrails" as one block keep working.
 */
export function renderGuardrails(): string {
  return `${renderOutputContract()}\n\n${renderArtifactRules()}`;
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
  /**
   * Include the repository grounding layer. Defaults to FALSE.
   *
   * Off by default because the rules reference a REPOSITORY FILES block that is
   * usually absent, and instructions about files the model does not have are worse
   * than no instructions. There is no incident on this side of the default, so the
   * safe direction is omission.
   */
  hasRepositoryContext?: boolean;
  /**
   * Include the artifact/download rules. Defaults to TRUE.
   *
   * The opposite default to the above, and deliberately so. Omitting these reproduces
   * a failure mode that has already regressed twice, so a caller that forgets to pass
   * anything must still get them. Only an explicit `false` — from a caller that has
   * actually checked `mentionsFileDelivery` — drops them.
   */
  includeArtifactRules?: boolean;
}

/**
 * Every static layer on its own, so callers can measure each without running a turn.
 *
 * `guardrails` is the output contract and artifact rules concatenated — retained
 * because it is the unit the pre-existing budget test and several callers reason
 * about. The two halves are also returned separately, since only one of them is
 * unconditional and a combined figure hides which half grew.
 */
export function buildStaticLayers(
  profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE
): Record<PromptLayerName, string> {
  return {
    identity: renderIdentity(),
    capabilities: renderCapabilities(profile),
    guardrails: renderGuardrails(),
    grounding: renderRepositoryGrounding(),
    outputContract: renderOutputContract(),
    artifactRules: renderArtifactRules(),
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

  // Note the asymmetric defaults — see BuildSystemPromptOptions for why each falls the
  // way it does. Both rule layers stay AFTER the task context so they keep the
  // end-of-prompt weighting the layering exists to buy.
  const grounding = options.hasRepositoryContext === true ? renderRepositoryGrounding() : "";
  const artifactRules = options.includeArtifactRules === false ? "" : renderArtifactRules();

  const prompt = [
    layers.identity,
    layers.capabilities,
    taskContext,
    grounding,
    renderOutputContract(),
    artifactRules,
  ]
    .map((layer) => layer.trim())
    .filter((layer) => layer.length > 0)
    .join("\n\n");

  // The static layers growing past the reserve silently under-reserves the context
  // budget, which surfaces later as an occasional overflow rather than an obvious
  // error. Tests assert the ceilings; this catches an overrun that reaches runtime.
  //
  // Measured on the layers ACTUALLY included this turn, not on every layer that
  // exists: since the rule layers became conditional, a fixed measurement would warn
  // about tokens a given request never paid for.
  const staticTokens = estimateTokens(
    [layers.identity, layers.capabilities, grounding, renderOutputContract(), artifactRules]
      .filter((layer) => layer.trim().length > 0)
      .join("\n\n")
  );

  if (staticTokens > STATIC_PROMPT_TOKEN_BUDGET) {
    logger.warn("System prompt static layers exceeded their token budget", {
      staticTokens,
      budget: STATIC_PROMPT_TOKEN_BUDGET,
      identity: estimateTokens(layers.identity),
      capabilities: estimateTokens(layers.capabilities),
      grounding: estimateTokens(grounding),
      outputContract: estimateTokens(renderOutputContract()),
      artifactRules: estimateTokens(artifactRules),
    });
  }

  return prompt;
}
