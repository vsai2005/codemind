/**
 * Header-phase timeout for provider requests.
 *
 * A provider that accepts a connection but never answers is worse than one that
 * errors: the request hangs indefinitely, holding a user's generation slot and (for
 * NVIDIA) an API-key lease, with nothing to classify and nothing to retry. That is not
 * hypothetical — a NIM model listed in the catalogue but not actually served behaves
 * exactly this way.
 *
 * The timeout deliberately covers ONLY the wait for response headers. `fetch` resolves
 * as soon as headers arrive, so the timer is cleared at that point and the body is then
 * free to stream for as long as the generation takes. A blanket timeout would instead
 * guillotine long, healthy generations mid-sentence.
 *
 * WHY THE BUDGET IS PER-REQUEST AND NOT JUST AN ENV VAR
 * Time-to-headers is a property of the MODEL, not of the deployment. Measured on
 * NVIDIA's endpoint on 2026-08-31: Nemotron answers headers in 0.4s, Kimi K3 in 175s,
 * because Kimi buffers its whole reasoning pass first. One global number cannot serve
 * both — set it at 60s and Kimi can never answer; set it at 240s and a genuinely hung
 * Gemini request holds a generation slot for four minutes instead of one. So the
 * default stays tight and a slow model carries its own larger budget, requested through
 * `HEADER_TIMEOUT_HEADER` on the outgoing init.
 */

const DEFAULT_HEADER_TIMEOUT_MS = 60_000;

/**
 * Per-request override, read off the outgoing headers and REMOVED before the request is
 * sent — it is an instruction to this module, not something a provider should ever see.
 *
 * A header is the carrier because the AI SDK gives no other per-call channel that
 * reaches a custom `fetch`: the provider instance is constructed once and shared, so
 * anything model-specific has to travel with the request itself.
 *
 * The VALUE IS SERVER-CHOSEN. It comes from the model registry, never from a request
 * body, so a client cannot ask for a longer timeout by sending one. The clamp below is
 * belt-and-braces against a future caller wiring it up carelessly.
 */
export const HEADER_TIMEOUT_HEADER = "x-codemind-header-timeout-ms";

/** Nothing may ask for less than the default's floor or more than five minutes. */
const MIN_OVERRIDE_MS = 1_000;
const MAX_OVERRIDE_MS = 300_000;

/**
 * Pull the override out of `init` if present, returning the timeout to use and headers
 * with the marker stripped. Returns the caller's headers untouched when absent, so the
 * common path allocates nothing extra.
 */
function takeOverride(
  init: RequestInit | undefined,
  fallback: number
): { timeoutMs: number; headers: HeadersInit | undefined } {
  if (!init?.headers) return { timeoutMs: fallback, headers: init?.headers };

  const headers = new Headers(init.headers);
  const raw = headers.get(HEADER_TIMEOUT_HEADER);
  if (raw === null) return { timeoutMs: fallback, headers: init.headers };

  headers.delete(HEADER_TIMEOUT_HEADER);
  const parsed = Number.parseInt(raw, 10);
  const timeoutMs = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, MIN_OVERRIDE_MS), MAX_OVERRIDE_MS)
    : fallback;

  return { timeoutMs, headers };
}

export function providerHeaderTimeoutMs(): number {
  const raw = process.env.AI_PROVIDER_HEADER_TIMEOUT_MS;
  if (!raw) return DEFAULT_HEADER_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEADER_TIMEOUT_MS;
}

/**
 * `fetch`, but give up if the provider has not sent response headers in time.
 *
 * A caller-supplied `init.signal` is still honoured: aborting it aborts the request,
 * and it keeps working after the header timer is cleared.
 */
export async function fetchWithHeaderTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  defaultTimeoutMs: number = providerHeaderTimeoutMs()
): Promise<Response> {
  const { timeoutMs, headers } = takeOverride(init, defaultTimeoutMs);
  const controller = new AbortController();
  const callerSignal = init?.signal;

  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Provider sent no response headers within ${timeoutMs}ms`));
  }, timeoutMs);

  const cleanup = (): void => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  try {
    const response = await fetch(input, { ...init, headers, signal: controller.signal });
    // Headers are in. Stop the clock so a slow-but-alive generation can stream
    // for as long as it needs.
    cleanup();
    return response;
  } catch (error) {
    cleanup();
    throw error;
  }
}
