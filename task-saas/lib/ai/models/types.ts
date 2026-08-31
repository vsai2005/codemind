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
  /**
   * How long to wait for this model's response HEADERS before giving up, in ms.
   *
   * Omitted for every model that answers promptly — they use the deployment-wide
   * default. Set it only for a model measured to be slow to first byte, and say what
   * was measured: this number exists to keep one slow model from forcing a loose
   * timeout on all the fast ones.
   */
  headerTimeoutMs?: number;
  /**
   * Short warning shown beside this model in the picker, for a model that works but
   * makes the user wait. Distinct from `comingSoon`, which means "cannot be chosen":
   * this one can, and the point is that the choice is informed rather than a surprise.
   */
  slowNotice?: string;
  /** Context window the provider supports for this model. */
  providerContextTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  /** Short UI badges, e.g. ["Long Context", "Coding"]. */
  strengths: string[];
  /** Operator switch: a disabled entry is never listed and never resolvable. */
  enabled: boolean;
  /**
   * Listed but not yet selectable, regardless of credentials. Unlike `enabled: false`
   * (which hides the model entirely), this keeps the name visible with a "Coming soon"
   * badge so users know the capability is planned. Enforced both client-side (picker
   * disables the row) and server-side (`resolveModel` rejects the id).
   */
  comingSoon?: boolean;
}

/** Client-safe. Never carries credentials or base URLs. */
export interface ClientModelInfo {
  id: string;
  displayName: string;
  providerLabel: string;
  strengths: string[];
  supportsVision: boolean;
  /** False when the provider key is not configured, or the model is `comingSoon`. */
  available: boolean;
  /** True for a model that is listed but not yet selectable. See ModelDescriptor. */
  comingSoon: boolean;
  /** Latency warning for a selectable but slow model, or null. See ModelDescriptor. */
  slowNotice: string | null;
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
  /**
   * True when the provider does its OWN bounded failover before the SDK ever sees a
   * failure — today only NVIDIA, whose gateway retries across the key pool.
   *
   * This drives whether AI SDK retry is allowed on top. Leaving both on multiplies:
   * the gateway's attempts times the SDK's, up to nine upstream calls for one turn.
   * Leaving both OFF is the opposite failure and is easy to miss, because the reason
   * given for disabling SDK retry ("the gateway handles it") is only true for NVIDIA.
   * For a single-credential provider nothing else is watching, so a transient
   * retryable 429 ends the turn outright.
   */
  hasOwnFailover: boolean;
  /** True when this provider's credentials are present in the environment. */
  isConfigured(): boolean;
  /**
   * Returns an AI SDK model. Must reuse a lazily-created provider instance so a client
   * is not constructed per request, and must throw rather than return an unusable model
   * when credentials are absent.
   */
  createModel(providerModelId: string): LanguageModelV1;
}
