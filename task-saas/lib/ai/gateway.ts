import { createOpenAI } from "@ai-sdk/openai";
import { logger } from "@/lib/logger";
import { acquireKey, configuredKeyCount, type KeyLease } from "./key-scheduler";
import { releaseOnStreamEnd } from "./stream-lifecycle";
import { fetchWithHeaderTimeout } from "./fetch-timeout";
import {
  classifyNetworkError,
  classifyResponse,
  type FailureClassification,
} from "./failure-classification";

/**
 * Centralized NVIDIA inference gateway.
 *
 * Every model call in CodeMind — streaming chat, vision, artifact generation and
 * background summarization — reaches the provider through the single `createOpenAI`
 * instance below, which routes all traffic through `fetchWithScheduler`. That makes
 * this function the one place where credentials are chosen, held and released, so no
 * call site needs to know that a key pool exists.
 *
 * WHAT MULTIPLE KEYS DO AND DO NOT DO
 * Multiple credentials let INDEPENDENT requests run concurrently. They do not enlarge
 * the model's context window and they are never combined: one generation uses exactly
 * one key for its entire lifetime. Throughput remains bounded by NVIDIA's account and
 * serving limits, not by the number of keys configured.
 *
 * LEASE LIFETIME — the subtle part
 * `fetch` resolves as soon as response headers arrive, but a streamed generation keeps
 * using the connection long afterwards. Releasing the key when `fetch` returns would
 * under-count in-flight work and let the scheduler oversubscribe a key. The response
 * body is therefore wrapped so the lease is released only when the stream truly ends —
 * on completion, on error, or on cancel (which is how a browser disconnect surfaces).
 */

/** Bounded failover attempts across DIFFERENT keys for one logical request. */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Backpressure when every key is at capacity. A few short waits absorb a burst without
 * building an unbounded queue; after that the caller gets a clean 503 rather than the
 * gateway hammering the provider.
 */
const ACQUIRE_ATTEMPTS = 3;
const ACQUIRE_RETRY_DELAY_MS = 250;

/**
 * Error bodies are small; cap what we read so a hostile body cannot balloon memory.
 * Must stay comfortably above a provider context-length message (~200 chars): the chat
 * route's recovery path matches on that text, so truncating it would silently downgrade
 * a user-actionable 400 into an opaque 500.
 */
const MAX_ERROR_BODY_CHARS = 2000;

/**
 * Backstop against a leaked lease. Normal completion, error and cancel all release
 * promptly; this only fires if a stream is abandoned without any terminal signal
 * (a platform-level timeout severing the socket, for instance).
 *
 * Sized near the realistic worst-case generation rather than generously: a long window
 * is no defence against a client that deliberately stalls its read, and every minute a
 * stalled lease survives is a minute of pool capacity denied to other users.
 */
const LEASE_MAX_LIFETIME_MS = 2 * 60_000;

/** Hard ceiling on operator-configured retries, so a typo cannot become a retry storm. */
const MAX_ALLOWED_RETRIES = 5;

/** Marker the chat route matches to surface a capacity problem as a 503. */
export const NO_CAPACITY_CODE = "codemind_no_capacity";

function maxRetries(): number {
  const raw = process.env.NVIDIA_MAX_RETRIES;
  if (!raw) return DEFAULT_MAX_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_RETRIES;
  return Math.min(parsed, MAX_ALLOWED_RETRIES);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Try to reserve a key, tolerating a brief burst where every key is momentarily full.
 *
 * The wait happens here, OUTSIDE the scheduler's synchronous select-and-reserve block,
 * so it cannot reintroduce the reservation race that block is designed to avoid.
 */
async function acquireWithBackpressure(exclude: readonly string[]): Promise<KeyLease | null> {
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    const lease = acquireKey(exclude);
    if (lease) return lease;
    if (attempt < ACQUIRE_ATTEMPTS - 1) await sleep(ACQUIRE_RETRY_DELAY_MS);
  }
  return null;
}

/** Synthetic response for "no key could be reserved". Carries no provider detail. */
function noCapacityResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: NO_CAPACITY_CODE,
        message: "All AI provider keys are busy or cooling down. Please retry shortly.",
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Hold `lease` until the response body finishes, errors, or is cancelled.
 *
 * `release()` is idempotent, so the overlapping paths here (a stream that completes and
 * is then cancelled by the consumer) cannot double-decrement the key's active count.
 */
function holdLeaseForStream(response: Response, lease: KeyLease): Response {
  return releaseOnStreamEnd(response, {
    // Normal completion, mid-stream error, or consumer cancel (browser disconnect).
    onSettled: () => lease.release(),
    timeoutMs: LEASE_MAX_LIFETIME_MS,
    onTimeout: () => {
      // The helper has already cancelled the upstream read, so the provider-side work
      // is genuinely finished rather than merely untracked. `abandon` returns the slot
      // without treating this as proof the key is healthy.
      logger.warn("AI gateway reclaimed a stalled lease", { key: lease.id });
      lease.abandon();
    },
  });
}

/** Read an error body once, then rebuild an equivalent Response for the SDK to parse. */
async function readErrorBody(response: Response): Promise<{ snippet: string; replay: Response }> {
  let snippet = "";
  try {
    snippet = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    snippet = "";
  }

  return {
    snippet,
    replay: new Response(snippet, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

function logFailure(lease: KeyLease, classification: FailureClassification, attempt: number): void {
  logger.warn("AI gateway request failed", {
    key: lease.id,
    attempt,
    kind: classification.kind,
    willFailover: classification.shouldFailover,
    // `reason` is scrubbed of credentials by the classification module.
    reason: classification.reason,
  });
}

/**
 * Credential-aware fetch used by the provider instance below.
 *
 * One logical request may touch several keys: on a retryable failure the key is cooled
 * down and a different one is tried, up to a bounded number of attempts. Failures that
 * cannot be fixed by another key — context length, malformed requests, aborts — are
 * returned to the caller immediately without spending the pool.
 */
async function fetchWithScheduler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const tried: string[] = [];
  const limit = maxRetries();

  for (let attempt = 1; attempt <= limit; attempt++) {
    const lease = await acquireWithBackpressure(tried);
    if (!lease) {
      logger.warn("AI gateway exhausted key capacity", {
        configuredKeys: configuredKeyCount(),
        attempt,
      });
      return noCapacityResponse();
    }

    tried.push(lease.id);

    // The scheduler decides which credential is used. Nothing from the request body or
    // the browser can influence this, and the secret never leaves this block.
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${lease.secret}`);

    let response: Response;
    try {
      // Deadline enforced per request shape: a stalled endpoint becomes a classifiable
      // failure instead of a request that hangs holding a lease.
      response = await fetchWithHeaderTimeout(input, { ...init, headers });
    } catch (error) {
      const classification = classifyNetworkError(error);

      // TWO WAYS OF NOT BLAMING THE KEY, and they are not the same event.
      //
      //   "aborted"  — the caller went away. Nobody is waiting for an answer.
      //   "deadline" — WE stopped waiting. Someone is still waiting, and they get an
      //                error that says so; but the provider never got the chance to
      //                fail, so there is nothing to charge to the credential.
      //
      // Neither may reach reportFailure. Before the deadline case existed, our own
      // timer arrived here as a plain Error, was classified "network", and benched a
      // working key for 30s — three keys and 175s for one slow 500-token request, which
      // read in the logs as a provider outage that was never happening.
      if (classification.kind === "aborted" || classification.kind === "deadline") {
        lease.release();
        if (classification.kind === "deadline") {
          logger.warn("AI gateway deadline exceeded", {
            key: lease.id,
            attempt,
            // Scrubbed by the classifier; names the budget and the request shape.
            reason: classification.reason,
          });
        }
        throw error;
      }

      lease.reportFailure(classification);
      logFailure(lease, classification, attempt);

      if (!classification.shouldFailover || attempt === limit) throw error;
      continue;
    }

    if (response.ok) {
      logger.debug("AI gateway request assigned", { key: lease.id, attempt });
      return holdLeaseForStream(response, lease);
    }

    const { snippet, replay } = await readErrorBody(response);
    const classification = classifyResponse(response.status, snippet);

    // Context-length rejections, malformed requests and other deterministic 4xx are
    // application problems: every key would answer identically, so the pool is not
    // spent and the key is not blamed. ContextManager recovery handles the former.
    if (!classification.shouldFailover) {
      lease.release();
      return replay;
    }

    lease.reportFailure(classification);
    logFailure(lease, classification, attempt);

    if (attempt === limit) return replay;
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  return noCapacityResponse();
}

if (configuredKeyCount() === 0) {
  logger.error("No NVIDIA API key configured; AI features will fail until one is set");
}

export const nvidia = createOpenAI({
  baseURL: process.env.NEMOTRON_BASE_URL || "https://integrate.api.nvidia.com/v1",
  // Placeholder only. The real credential is chosen per request by the scheduler and
  // written into the Authorization header inside fetchWithScheduler.
  apiKey: "managed-by-key-scheduler",
  fetch: fetchWithScheduler,
  /**
   * Makes the provider report token usage on the streaming path.
   *
   * @ai-sdk/openai adds `stream_options: { include_usage: true }` to the streaming
   * request body only under "strict"; the default "compatible" omits it, the endpoint
   * then sends no usage chunk, and the SDK leaves usage at its NaN seed. That is why
   * Message.promptTokens / completionTokens were always null.
   *
   * Verified against the SDK: "strict" changes NOTHING else — not headers, not
   * getArgs, not the failed-response handler. The only difference on the wire is that
   * one extra body field (dist/index.js:494-495).
   *
   * Set on NVIDIA ONLY, and verified against the live integrate API. Google and
   * DeepSeek stay "compatible" until each is tested the same way; Gemini's
   * compatibility layer is already known to reject some OpenAI-shaped fields.
   */
  compatibility: "strict",
});

export const getVisionModel = () =>
  nvidia(process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-90b-vision-instruct");

export const getModel = () => nvidia(process.env.NEMOTRON_MODEL || "nvidia/nemotron-3-ultra-550b-a55b");

export const nemotronOptions = {};

export { getKeyStats } from "./key-scheduler";
