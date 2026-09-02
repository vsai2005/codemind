import { getContextTokenLimit, getOutputTokenLimit } from "@/lib/ai/context-manager";
import { getArtifactOutputTokenLimit } from "@/lib/env";
import { getProviderAdapter } from "./providers";
import type { ClientModelInfo, ModelDescriptor, ResolvedModel } from "./types";

/**
 * The model registry: one in-memory table of every model CodeMind will talk to, plus the
 * resolution logic that turns a client-supplied id into a usable AI SDK model.
 *
 * WHY A TABLE AND NOT A DATABASE
 * Model selection sits on the hot path of every chat request. A DB round trip (or worse,
 * a provider "list models" call) to answer "which model did the user pick?" would add
 * latency and a failure mode to every message, and would make the set of reachable models
 * mutable at runtime by whoever can write that table. The table is code: it is reviewed,
 * deployed, and cannot drift.
 *
 * WHY THIS IS A SECURITY BOUNDARY
 * The model id arrives from the browser. `resolveModel` is the chokepoint that decides
 * whether that string ever becomes a real provider model id on an outbound API call.
 * Anything not in this table is rejected outright — an unregistered id must never be
 * forwarded to a provider, because doing so would let a client pick arbitrary models
 * (different pricing, different safety posture, possibly a different tenant's endpoint)
 * simply by editing a request body. The client sends CodeMind ids; only this module knows
 * the real provider ids they map to.
 */

/**
 * How much context CodeMind is willing to send, regardless of what a provider allows.
 *
 * A PROVIDER SUPPORTING 1M TOKENS DOES NOT MEAN CODEMIND SHOULD SEND 1M. Every token in
 * the prompt is paid for on every turn, inflates time-to-first-token, and — past a point
 * — measurably degrades answer quality as relevant context is diluted by filler. This
 * ceiling is CodeMind's product decision about the cost/latency/quality trade-off; the
 * provider's advertised window is only an upper bound on what would be *accepted*.
 */
const CODEMIND_TARGET_CONTEXT_TOKENS = 512_000;

/** Shared across the current generation of frontier models in this table. */
const FRONTIER_CONTEXT_TOKENS = 1_048_576;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * DeepSeek V4 Flash emits a reasoning pass before its answer, and both are billed
 * against the same output budget. 16k leaves room for the thinking tokens without the
 * visible reply being cut off mid-sentence.
 *
 * Separate question, still UNANSWERED: whether the usage this provider REPORTS counts
 * the reasoning pass in completionTokens or only the visible reply. That is not the
 * same as the ceiling above, and it remains unmeasured because this model reports no
 * usage at all while streaming — see the compatibility note in
 * lib/ai/models/providers.ts. Until it is measured, do not treat DeepSeek
 * completionTokens as "length of the visible reply".
 */
const DEEPSEEK_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Kimi K3 emits a reasoning pass before its answer — responses carry a separate
 * `reasoning_content` field, and those tokens are billed against the same output budget
 * as the visible reply. Same argument as DeepSeek above: an 8k ceiling risks the answer
 * being truncated by the model's own thinking. NVIDIA's own sample for this model uses
 * 16,384, which is also where AI_MAX_OUTPUT_TOKENS sits, so nothing here is speculative.
 *
 * The question left UNANSWERED for DeepSeek — whether reported completionTokens count
 * the reasoning pass or only the visible reply — IS answered here, because unlike
 * DeepSeek this model reports usage while streaming. Measured 2026-08-31: a prompt whose
 * visible reply was the five characters "$0.05" streamed 123 characters of
 * reasoning_content and reported completion_tokens: 69. Reasoning is counted.
 *
 * That is worth knowing when reading the usage figures in the header or /settings: a
 * Kimi turn's completion count reflects thinking the user never sees, so a one-word
 * answer can legitimately cost dozens of tokens. It is not a bug in the accounting.
 */
const KIMI_K3_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Inkling Small reasons by DEFAULT. OpenRouter reports `reasoning.default_enabled: true`
 * with a default effort of "high" — not mandatory, unlike the withdrawn Ox Alpha, so a
 * non-reasoning path exists, but nothing here turns it off. Those thinking tokens bill
 * against the same output budget as the visible reply, so a ceiling sized for the answer
 * alone would let a model truncate itself with its own reasoning pass.
 *
 * The provider allows 262,144. This is deliberately far lower, for the reason the chat
 * clamp already encodes: `resolveModel` takes the min of this and AI_MAX_OUTPUT_TOKENS
 * (16,384 by default), so the runtime budget is what binds today either way. Claiming
 * the provider's full headroom here would only matter if an operator raised that budget,
 * and a quarter of a million output tokens is a cost and latency decision to make
 * deliberately rather than inherit from a catalogue.
 */
const INKLING_SMALL_MAX_OUTPUT_TOKENS = 32_768;

/**
 * MEASURED, not advertised. NVIDIA's /v1/models returns no context metadata for this
 * model and the endpoint accepts any max_tokens without complaint, so the window was
 * established by probing: a 546,087-token prompt was accepted and answered on
 * 2026-08-31. It was not probed higher.
 *
 * 524,288 is that measurement rounded down to a power of two. It is deliberately NOT
 * FRONTIER_CONTEXT_TOKENS: the other entries there use a figure the provider publishes,
 * and claiming 1M for this model would be asserting something no one has checked. The
 * distinction is free today — CODEMIND_TARGET_CONTEXT_TOKENS caps sends at 512,000
 * either way — but it stops being free the moment an operator raises that ceiling.
 */
const KIMI_K3_CONTEXT_TOKENS = 524_288;

/** Fallback when NVIDIA_VISION_MODEL is unset. Mirrors lib/ai/gateway.ts. */
const DEFAULT_NVIDIA_VISION_MODEL = "meta/llama-3.2-90b-vision-instruct";

/**
 * The registry table.
 *
 * `providerModelId` is read from the environment at call time rather than frozen at
 * import, so an operator can point an entry at a newer provider snapshot (or a staging
 * deployment) without a code change — the same lazy-env discipline the key scheduler uses.
 *
 * Order is meaningful: `getDefaultModelId` walks this list, so the first entry is the
 * house default whenever its provider is configured.
 */
function buildRegistry(): ModelDescriptor[] {
  return [
    {
      id: "nemotron-3-ultra",
      displayName: "Nemotron 3 Ultra",
      provider: "nvidia",
      providerLabel: "NVIDIA",
      providerModelId: process.env.NEMOTRON_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
      providerContextTokens: FRONTIER_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      supportsStreaming: true,
      supportsVision: false,
      strengths: ["Long Context", "Coding", "Reasoning"],
      enabled: true,
    },
    {
      id: "kimi-k3",
      displayName: process.env.KIMI_DISPLAY_NAME || "Kimi K3",
      // Served over NVIDIA's integrate API, so it rides the SAME adapter and the same
      // NVIDIA_API_KEY_1..5 pool as Nemotron — multi-key scheduling, cooldowns and
      // failover included, with no new credential to configure. This is why it is not
      // a separate provider the way DeepSeek is: DeepSeek shares the host but is billed
      // to a different account, and Kimi is not.
      provider: "nvidia",
      providerLabel: "NVIDIA",
      providerModelId: process.env.KIMI_MODEL || "moonshotai/kimi-k3",
      /**
       * MEASURED 2026-08-31: 175s, 179s, 186s and 197s to response headers across four
       * runs, versus 0.4s for Nemotron on the same endpoint and the same key. Kimi
       * buffers its entire reasoning pass before sending headers, and the delay is
       * fixed overhead — a one-word "hi" costs the same as a long prompt, and
       * reasoning_effort makes no difference ("medium" is rejected outright with a 400).
       *
       * Under the 60s default this model could not answer at all: the gateway timed
       * out, cooled down a key, failed over, and repeated until the request 504'd after
       * three minutes having burned three keys. 240s leaves headroom over the slowest
       * run observed without reaching the 300s ceiling in fetch-timeout.ts.
       *
       * This is a workaround for someone else's queue, not a property of the model
       * worth keeping forever. If NVIDIA's endpoint speeds up, delete the line.
       */
      headerTimeoutMs: 240_000,
      // The user-facing half of the same measurement. Kimi is selectable and does
      // answer, so the honest thing is to let people choose it knowing the cost —
      // silently taking three minutes is what makes an app feel broken.
      slowNotice: "~3 min to first reply",
      providerContextTokens: KIMI_K3_CONTEXT_TOKENS,
      maxOutputTokens: KIMI_K3_MAX_OUTPUT_TOKENS,
      supportsStreaming: true,
      // Verified against the live endpoint on 2026-08-31, not inferred from a catalog
      // listing: an image_url message was sent and correctly described. That matters
      // because supportsVision drives real routing — declaring it wrongly either sends
      // images to a model that cannot read them, or diverts them to the NVIDIA vision
      // model and throws away this model's own reasoning about the picture.
      supportsVision: true,
      strengths: ["Long Context", "Multimodal", "Reasoning"],
      enabled: true,
    },
    {
      id: "gemini-3-1-pro",
      // Env-overridable because the usable Gemini model depends on the account's
      // quota tier: Pro ids return 429 on a Flash-only key, so an operator needs to
      // point this at a model they can actually call without a code change.
      displayName: process.env.GEMINI_DISPLAY_NAME || "Gemini 3.1 Pro",
      provider: "google",
      providerLabel: "Google",
      // Verified id form: the OpenAI-compatible endpoint accepts the bare id.
      // "gemini-3.1-pro" (no suffix) does not exist and 404s.
      providerModelId: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
      providerContextTokens: FRONTIER_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      supportsStreaming: true,
      supportsVision: true,
      strengths: ["Long Context", "Multimodal", "Reasoning"],
      enabled: true,
    },
    {
      id: "deepseek-v4-flash",
      displayName: process.env.DEEPSEEK_DISPLAY_NAME || "DeepSeek V4 Flash",
      provider: "deepseek",
      providerLabel: "DeepSeek",
      providerModelId: process.env.DEEPSEEK_MODEL || "deepseek-ai/deepseek-v4-flash-0731",
      providerContextTokens: FRONTIER_CONTEXT_TOKENS,
      // A reasoning model: it spends output tokens on a thinking pass before the
      // visible answer, so a normal 8k ceiling can truncate the reply itself.
      maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
      supportsStreaming: true,
      supportsVision: false,
      strengths: ["Long Context", "Coding", "Reasoning"],
      enabled: true,
      // Provider health has been unreliable — see the DeepSeek project memory notes
      // (52-102s to first header on 2026-08-22, then hanging with zero response on
      // 2026-08-24 while Nemotron on the same NVIDIA host stayed responsive). Listed
      // so users know it's coming, but not selectable until that's resolved.
      comingSoon: true,
    },

    {
      id: "inkling-small",
      displayName: process.env.OPENROUTER_DISPLAY_NAME || "Inkling Small",
      provider: "openrouter",
      providerLabel: "OpenRouter",
      /**
       * Resolved from OpenRouter's public catalogue on 2026-09-02, not guessed from the
       * display name: the `:free` suffix is a distinct id from `thinkingmachines/
       * inkling-small`, and the catalogue also carries `:batch` and a full-size
       * `inkling`. Env-overridable so an operator can move to the paid id — or off a
       * free tier that gets withdrawn — without a deploy. That is not hypothetical:
       * the last OpenRouter entry here was deleted when its id 404'd upstream.
       */
      providerModelId: process.env.OPENROUTER_MODEL || "thinkingmachines/inkling-small:free",
      // Catalogue reports 1,048,576 — the same window the other frontier entries use.
      providerContextTokens: FRONTIER_CONTEXT_TOKENS,
      maxOutputTokens: INKLING_SMALL_MAX_OUTPUT_TOKENS,
      // UNVERIFIED against the live endpoint, unlike Kimi's entry below-the-line notes.
      // OpenRouter serves SSE for every model it brokers, so this is the safe default
      // rather than a measurement; the first real turn confirms or corrects it.
      supportsStreaming: true,
      /**
       * `input_modalities` is ["text","image","audio"]. Only the image half is reachable
       * from CodeMind: /api/upload accepts images as data URLs and rejects audio and
       * video outright. So vision here means images, as it does for Gemini.
       */
      supportsVision: true,
      strengths: ["Long Context", "Coding", "Reasoning"],
      enabled: true,
    },
  ];
}

/** Descriptors are rebuilt per call so env overrides stay live; the cost is negligible. */
function registry(): ModelDescriptor[] {
  return buildRegistry();
}

/**
 * The NVIDIA vision model is deliberately NOT a registry entry.
 *
 * It is not user-selectable: the chat route switches to it automatically when a request
 * carries an image, and switches back otherwise. Listing it would let a client pick a
 * vision-only model for a text conversation. This helper exists so the route keeps a
 * single source for the env-or-default id instead of re-deriving it.
 */
export function getNvidiaVisionModelId(): string {
  return process.env.NVIDIA_VISION_MODEL || DEFAULT_NVIDIA_VISION_MODEL;
}

/** Every model an operator has left enabled, in registry order. */
export function listModels(): ModelDescriptor[] {
  return registry().filter((descriptor) => descriptor.enabled);
}

/**
 * Client-safe view of the enabled models.
 *
 * Unconfigured providers are listed with `available: false` rather than hidden, so the
 * picker can show the model greyed out — telling the user the capability exists but is
 * not switched on beats it vanishing with no explanation. Nothing here reveals a base
 * URL, a real provider model id, or a credential.
 */
export function listModelsForClient(): ClientModelInfo[] {
  return listModels().map((descriptor) => ({
    id: descriptor.id,
    displayName: descriptor.displayName,
    providerLabel: descriptor.providerLabel,
    strengths: descriptor.strengths,
    supportsVision: descriptor.supportsVision,
    available:
      !descriptor.comingSoon && getProviderAdapter(descriptor.provider).isConfigured(),
    comingSoon: descriptor.comingSoon ?? false,
    slowNotice: descriptor.slowNotice ?? null,
  }));
}

/** Look up a descriptor by CodeMind id. Returns null for unknown ids — never throws. */
export function getModelDescriptor(id: string): ModelDescriptor | null {
  return registry().find((descriptor) => descriptor.id === id) ?? null;
}

/** Registered AND enabled AND not comingSoon AND its provider has credentials. */
export function isModelAvailable(id: string): boolean {
  const descriptor = getModelDescriptor(id);
  if (!descriptor || !descriptor.enabled || descriptor.comingSoon) return false;
  return getProviderAdapter(descriptor.provider).isConfigured();
}

/**
 * The id to use when the caller expressed no preference.
 *
 * Prefers the first model that can actually serve a request, so a deployment configured
 * with only one provider's keys still gets a working default. Falls back to the first
 * registered id when nothing is configured: callers get a stable, resolvable-looking id
 * and a clear failure from `resolveModel`, rather than an empty string to special-case.
 */
export function getDefaultModelId(): string {
  const models = listModels();
  const available = models.find(
    (descriptor) => !descriptor.comingSoon && getProviderAdapter(descriptor.provider).isConfigured()
  );
  if (available) return available.id;

  const fallback = models[0] ?? registry()[0];
  return fallback.id;
}

/**
 * Turn a (possibly client-supplied) model id into a ready-to-use model, or throw.
 *
 * This is the enforcement point described in the module header: an id that is not in the
 * table is rejected here and never reaches a provider API.
 */
export function resolveModel(id: string): ResolvedModel {
  const descriptor = getModelDescriptor(id);

  // Naming the rejected id keeps the failure debuggable. It is a value the caller already
  // sent, so echoing it discloses nothing they did not supply.
  if (!descriptor) {
    throw new Error(`Unknown model id: ${id}`);
  }

  if (!descriptor.enabled) {
    throw new Error(`Model is disabled: ${id}`);
  }

  if (descriptor.comingSoon) {
    throw new Error(`Model is not yet available: ${id}`);
  }

  const adapter = getProviderAdapter(descriptor.provider);
  if (!adapter.isConfigured()) {
    throw new Error(`Provider ${descriptor.providerLabel} is not configured for model: ${id}`);
  }

  // Three independent ceilings, and the tightest wins:
  //   1. CODEMIND_TARGET_CONTEXT_TOKENS — the product's cost/latency/quality decision.
  //      A provider supporting 1M does NOT mean CodeMind should send 1M.
  //   2. descriptor.providerContextTokens — a hard limit; exceeding it is a 400.
  //   3. getContextTokenLimit() — the runtime budget (AI_CONTEXT_MAX_TOKENS), which lets
  //      an operator tighten things further without a deploy.
  const effectiveContextTokens = Math.min(
    CODEMIND_TARGET_CONTEXT_TOKENS,
    descriptor.providerContextTokens,
    getContextTokenLimit()
  );

  const effectiveOutputTokens = Math.min(descriptor.maxOutputTokens, getOutputTokenLimit());

  return {
    descriptor,
    // Throws if credentials vanished between the check above and here — an adapter is
    // never allowed to hand back a model it cannot authenticate.
    model: adapter.createModel(descriptor.providerModelId),
    effectiveContextTokens,
    effectiveOutputTokens,
  };
}

/**
 * Output budget for an ARTIFACT generation on a given model.
 *
 * THE DEFECT THIS CLOSES
 * `generateArtifact` passed `getArtifactOutputTokenLimit()` straight through — a flat
 * 16,000 regardless of which model was answering. Nemotron and Gemini both declare
 * 8,192, so the artifact path asked for roughly twice what those models advertise,
 * while the chat path two lines above correctly clamped to the descriptor. The registry
 * is the authority on what a model can produce, and exactly one path was bypassing it.
 *
 * SAME SHAPE AS `effectiveOutputTokens`, DIFFERENT BUDGET. The tightest of the two
 * ceilings wins: the model's declared maximum and the operator's env budget. So
 * AI_ARTIFACT_MAX_OUTPUT_TOKENS can always lower the limit and can never raise it past
 * what the model says it can emit — the same rule the chat path follows.
 *
 * WHY THIS IS A FUNCTION AND NOT A FIELD ON `ResolvedModel`
 * `effectiveContextTokens` and `effectiveOutputTokens` are computed once, when the model
 * is resolved. That is fine for chat, which resolves per request. It is WRONG here: the
 * measurement harness resolves a model once at startup and then lowers
 * AI_ARTIFACT_MAX_OUTPUT_TOKENS per case to force truncation deterministically. A field
 * captured at resolve time would freeze the startup value and silently ignore that,
 * turning the truncation fixture into a test of nothing. Reading the environment at
 * generation time keeps the override live.
 *
 * `modelMaxOutputTokens` is optional because `generateArtifact` may fall back to the
 * gateway's default model, which reaches it as an opaque `LanguageModelV1` with no
 * descriptor attached. Absent means "no declared ceiling known", which yields the env
 * budget alone — the previous behaviour, unchanged, for that one path.
 */
export function artifactOutputTokensFor(modelMaxOutputTokens?: number): number {
  const budget = getArtifactOutputTokenLimit();
  return modelMaxOutputTokens === undefined ? budget : Math.min(modelMaxOutputTokens, budget);
}
