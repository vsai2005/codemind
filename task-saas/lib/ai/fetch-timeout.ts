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
 */

const DEFAULT_HEADER_TIMEOUT_MS = 60_000;

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
  timeoutMs: number = providerHeaderTimeoutMs()
): Promise<Response> {
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
    const response = await fetch(input, { ...init, signal: controller.signal });
    // Headers are in. Stop the clock so a slow-but-alive generation can stream
    // for as long as it needs.
    cleanup();
    return response;
  } catch (error) {
    cleanup();
    throw error;
  }
}
