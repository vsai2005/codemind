import type { LanguageModelV1 } from "ai";

/**
 * Shared vocabulary for CodeMind's multi-provider model layer.
 *
 * WHY A SEPARATE TYPES MODULE
 * The registry (data + resolution) and the provider adapters (credentials + client
 * construction) both need these shapes, and each needs the other's types. Keeping the
 * contracts here means neither module has to import the other, so there is no import
 * cycle between "which models exist" and "how a provider is reached".
 *
 * SECURITY BOUNDARY
 * Two of these shapes cross the network to the browser (`ClientModelInfo`) and two never
 * do (`ModelDescriptor`, `ResolvedModel`). The split is deliberate: base URLs, real
 * provider model ids and provider internals stay server-side, because they are useful to
 * an attacker probing what this deployment talks to. Nothing in this file — and nothing
 * assignable to these types — may ever carry an API key.
 */

/** Every provider CodeMind can reach. Adding one means adding an adapter. */
export type ProviderId = "nvidia" | "google" | "deepseek";

/**
 * Server-side truth about one selectable model.
 *
 * `providerContextTokens` is what the PROVIDER advertises, not what CodeMind sends —
 * see the effective-limit computation in the registry for why those differ.
 */
export interface ModelDescriptor {
  /** Stable CodeMind id, safe to expose to the client. */
  id: string;
  displayName: string;
  provider: ProviderId;
  /** Human-facing provider name: "NVIDIA" | "Google" | "DeepSeek". */
  providerLabel: string;
  /** Real API model id sent to the provider. Server-side only. */
  providerModelId: string;
  /** Context window the provider supports for this model. */
  providerContextTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  /** Short UI badges, e.g. ["Long Context", "Coding"]. */
  strengths: string[];
  /** Operator switch: a disabled entry is never listed and never resolvable. */
  enabled: boolean;
}

/** Client-safe. Never carries credentials or base URLs. */
export interface ClientModelInfo {
  id: string;
  displayName: string;
  providerLabel: string;
  strengths: string[];
  supportsVision: boolean;
  /** False when the provider key is not configured in this environment. */
  available: boolean;
}

/**
 * A model that passed every registry check and is ready to hand to the AI SDK.
 *
 * The effective limits are carried alongside the model because the call site needs the
 * same numbers the registry used when it trimmed the provider's advertised window down
 * to what CodeMind is actually willing to send.
 */
export interface ResolvedModel {
  descriptor: ModelDescriptor;
  /** Ready for streamText/generateText. */
  model: LanguageModelV1;
  effectiveContextTokens: number;
  effectiveOutputTokens: number;
}

/**
 * How one provider is reached. Implementations own credential detection and client
 * construction; they own no model metadata — that lives in the registry table.
 */
export interface ProviderAdapter {
  id: ProviderId;
  /** True when this provider's credentials are present in the environment. */
  isConfigured(): boolean;
  /**
   * Returns an AI SDK model. Must reuse a lazily-created provider instance so a client
   * is not constructed per request, and must throw rather than return an unusable model
   * when credentials are absent.
   */
  createModel(providerModelId: string): LanguageModelV1;
}
