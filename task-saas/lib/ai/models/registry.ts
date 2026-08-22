import { getContextTokenLimit, getOutputTokenLimit } from "@/lib/ai/context-manager";
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
    available: getProviderAdapter(descriptor.provider).isConfigured(),
  }));
}

/** Look up a descriptor by CodeMind id. Returns null for unknown ids — never throws. */
export function getModelDescriptor(id: string): ModelDescriptor | null {
  return registry().find((descriptor) => descriptor.id === id) ?? null;
}

/** Registered AND enabled AND its provider has credentials. All three must hold. */
export function isModelAvailable(id: string): boolean {
  const descriptor = getModelDescriptor(id);
  if (!descriptor || !descriptor.enabled) return false;
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
  const available = models.find((descriptor) =>
    getProviderAdapter(descriptor.provider).isConfigured()
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
