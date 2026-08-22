import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { nvidia } from "@/lib/ai/gateway";
import { configuredKeyCount } from "@/lib/ai/key-scheduler";
import { fetchWithHeaderTimeout } from "@/lib/ai/fetch-timeout";
import type { ProviderAdapter, ProviderId } from "./types";

/**
 * Provider adapters: the only place in CodeMind that turns a provider model id into a
 * live AI SDK model.
 *
 * WHY EVERY ADAPTER USES `createOpenAI`
 * All three providers expose an OpenAI-compatible HTTP surface (NVIDIA's integrate API,
 * Google's `/v1beta/openai` compatibility endpoint, and DeepSeek via that same NVIDIA
 * host on a separate credential). Routing
 * them through one client shape keeps a single request/response code path — and, just as
 * importantly, takes zero additional npm dependencies. No provider-specific SDK is
 * installed or needed.
 *
 * WHY NVIDIA IS DIFFERENT AND MUST STAY DIFFERENT
 * The NVIDIA adapter does NOT build its own client. It reuses the `nvidia` instance
 * exported by lib/ai/gateway.ts, because that instance carries `fetchWithScheduler` in
 * its custom `fetch`: multi-key selection, per-key concurrency caps, cooldowns, failover
 * and lease-until-stream-end all live there. A fresh `createOpenAI` for NVIDIA would
 * compile, would appear to work with a single key, and would silently bypass the entire
 * key scheduler. Import the instance; never re-create it.
 *
 * SECURITY
 * A key value is never logged, never embedded in an Error, and never returned. Errors
 * name the MISSING ENV VAR, which is actionable for an operator and reveals nothing.
 *
 * LAZINESS
 * Clients are built on first use and memoised at module scope. Next.js evaluates modules
 * during build and route bundling where env vars may not be populated yet, so reading the
 * environment at import time can capture the wrong (or empty) values — the same reason
 * the key scheduler loads its pool lazily. Memoising also keeps a request from paying to
 * construct a client it could have shared.
 */

/** Google's OpenAI-compatibility endpoint. Overridable for proxies and regional hosts. */
const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * DeepSeek is served through NVIDIA's integrate API, the same host Nemotron uses.
 *
 * It is still a SEPARATE adapter with its own credential rather than a second model on
 * the NVIDIA adapter, because it is billed against a different key. Folding it into the
 * NVIDIA pool would let the scheduler hand a DeepSeek request a Nemotron-only key (and
 * vice versa), turning a routine failover into a 404. Same host, different account.
 */
const DEFAULT_DEEPSEEK_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** An `@ai-sdk/openai` provider instance: call it with a model id to get a model. */
type OpenAICompatibleProvider = ReturnType<typeof createOpenAI>;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * Build the "not configured" failure once, so every adapter fails identically and no
 * variant of this message can drift into interpolating the key itself.
 */
function missingCredentialError(envVar: string): Error {
  return new Error(`${envVar} is not configured; this model is unavailable.`);
}

// ---------------------------------------------------------------------------
// NVIDIA — delegates to the scheduler-backed gateway instance
// ---------------------------------------------------------------------------

const nvidiaAdapter: ProviderAdapter = {
  id: "nvidia",
  isConfigured(): boolean {
    // The pool may hold several keys; one is enough to serve traffic.
    return configuredKeyCount() > 0;
  },
  createModel(providerModelId: string): LanguageModelV1 {
    if (configuredKeyCount() === 0) {
      throw missingCredentialError("NVIDIA_API_KEY");
    }
    // Shared gateway instance — carries the multi-key scheduler in its custom fetch.
    return nvidia(providerModelId);
  },
};

// ---------------------------------------------------------------------------
// Google — OpenAI-compatible Gemini endpoint
// ---------------------------------------------------------------------------

let googleClient: OpenAICompatibleProvider | null = null;

const googleAdapter: ProviderAdapter = {
  id: "google",
  isConfigured(): boolean {
    return readEnv("GEMINI_API_KEY") !== null;
  },
  createModel(providerModelId: string): LanguageModelV1 {
    const apiKey = readEnv("GEMINI_API_KEY");
    if (!apiKey) throw missingCredentialError("GEMINI_API_KEY");

    if (!googleClient) {
      googleClient = createOpenAI({
        baseURL: readEnv("GEMINI_BASE_URL") ?? DEFAULT_GOOGLE_BASE_URL,
        apiKey,
        // Gemini's compatibility layer rejects the OpenAI org/project headers.
        compatibility: "compatible",
        // Fail fast if the endpoint accepts the connection but never answers.
        fetch: (input, init) => fetchWithHeaderTimeout(input, init),
      });
    }

    return googleClient(providerModelId);
  },
};

// ---------------------------------------------------------------------------
// DeepSeek — served over NVIDIA's OpenAI-compatible integrate API
// ---------------------------------------------------------------------------

let deepseekClient: OpenAICompatibleProvider | null = null;

const deepseekAdapter: ProviderAdapter = {
  id: "deepseek",
  isConfigured(): boolean {
    return readEnv("DEEPSEEK_API_KEY") !== null;
  },
  createModel(providerModelId: string): LanguageModelV1 {
    const apiKey = readEnv("DEEPSEEK_API_KEY");
    if (!apiKey) throw missingCredentialError("DEEPSEEK_API_KEY");

    if (!deepseekClient) {
      deepseekClient = createOpenAI({
        baseURL: readEnv("DEEPSEEK_BASE_URL") ?? DEFAULT_DEEPSEEK_BASE_URL,
        apiKey,
        /**
         * Stays "compatible", so this model reports NO token usage while streaming:
         * @ai-sdk/openai sends `stream_options: { include_usage: true }` only under
         * "strict", and without it the SDK leaves usage at its NaN seed and
         * Message.promptTokens / completionTokens are written null.
         *
         * "strict" WAS TESTED HERE (2026-08-22) AND THE RESULT WAS INCONCLUSIVE —
         * not negative. The model was too congested to measure:
         *
         *   stream, no stream_options    200 OK, first header after  51.9s
         *   stream, no stream_options    200 OK, first header after 102.2s
         *   stream, no stream_options    aborted at 240s
         *   non-stream, no stream_options aborted at  90s
         *   stream, WITH stream_options  aborted at 240s (x2)
         *
         * Probes carrying NONE of the change failed the same way, so the timeouts
         * cannot be attributed to stream_options. Two further points argue the field
         * itself is fine: a malformed request to this same endpoint returns 400 in
         * ~95ms, which is what parameter rejection looks like rather than a 240s
         * hang; and the NVIDIA adapter sends stream_options to this very host
         * (integrate.api.nvidia.com) and gets usage back promptly.
         *
         * RE-TEST when the model is not saturated — baseline first-header latency
         * under ~5s — and flip to "strict" only if a with-field probe returns finite
         * usage. Do not flip it on the reasoning above alone.
         *
         * Google/Gemini deliberately stays "compatible" too: its compatibility layer
         * is known to reject some OpenAI-shaped fields and has not been tested.
         */
        compatibility: "compatible",
        // Fail fast if the endpoint accepts the connection but never answers.
        fetch: (input, init) => fetchWithHeaderTimeout(input, init),
      });
    }

    return deepseekClient(providerModelId);
  },
};

/**
 * Adapter table. Exhaustive over ProviderId, so adding a provider to that union is a
 * compile error until an adapter exists for it.
 */
const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  nvidia: nvidiaAdapter,
  google: googleAdapter,
  deepseek: deepseekAdapter,
};

/** Adapter for a provider id. Total over ProviderId — never null. */
export function getProviderAdapter(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}

/** Every adapter, for health checks and availability sweeps. */
export function listProviderAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}
