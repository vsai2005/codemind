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

/**
 * Deadline for a STREAMED request: how long to wait for response headers.
 *
 * Genuinely a time-to-first-byte budget. An SSE response sends `200 text/event-stream`
 * before the model has produced anything, so this clock stops in well under a second on
 * a healthy provider and the body then streams for as long as the generation takes.
 *
 * Deliberately tight, and it must stay tight: this is the only thing standing between a
 * provider that accepts connections without answering and a generation slot held open
 * indefinitely.
 */
const STREAMING_HEADER_TIMEOUT_MS = 60_000;

/**
 * Deadline for a NON-STREAMED request, and the reason this file has two constants.
 *
 * THE DEFECT THIS EXISTS TO FIX
 * The timer below is cleared when `fetch()` resolves, which is when response headers
 * arrive. For a streamed response that is first-byte. For a NON-streamed one the server
 * writes nothing at all until the entire completion has been generated and it can send
 * a Content-Length — so the identical constant silently stops being a header budget and
 * becomes a ceiling on TOTAL GENERATION TIME. Under the 60s streaming value, any
 * artifact generation running longer than a minute was aborted no matter how healthy
 * the provider was, and the resulting error still said "sent no response headers".
 *
 * WHERE 180s COMES FROM, since a deadline invented from nothing is how the last one
 * went wrong. Nineteen successful artifact turns are recorded in the measurement
 * conversations: median 9s, p90 15s, max 48s — and that 48s already sat under the old
 * 60s wall with almost nothing to spare. Those measurements were taken with the largest
 * artifact at roughly 3,400 output tokens; the registry clamp now permits 8,192, about
 * 2.4x more, which extrapolates to ~116s IF generation time scales linearly with output
 * length. That linearity is an assumption, not something measured here. 180s carries
 * roughly 55% margin over the extrapolation and stays inside MAX_OVERRIDE_MS below.
 *
 * The sample is thin — 19 turns, one provider family, none near the new token ceiling —
 * so this errs loose on purpose. It is still a bound: a hung provider aborts at three
 * minutes rather than never.
 */
const NON_STREAMING_COMPLETION_TIMEOUT_MS = 180_000;

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

/**
 * Thrown when OUR OWN timer gives up, as distinct from the provider failing.
 *
 * THE DEFECT THIS CLOSES
 * The timer used to abort with a bare `new Error(...)`. A plain Error matches none of
 * the three names `isAbortError` looks for, so `classifyNetworkError` fell through to
 * `kind: "network"` — shouldFailover true, 30s cooldown — and the gateway benched a
 * perfectly healthy key for the crime of being slower than a deadline WE chose. One
 * 500-token request cooled three of six keys and took 175s to surface as what looked
 * like a provider outage. The classifier already had the right branch for "we stopped
 * waiting"; the timer simply never produced an object that could reach it.
 *
 * A CLASS RATHER THAN A MESSAGE PREFIX. The message now embeds a deadline that varies
 * by request shape, so matching on text would be matching on a moving target — and a
 * provider is perfectly capable of putting the word "timeout" in an error of its own.
 * Identity cannot be faked by anything arriving over the wire.
 *
 * The three sources stay distinguishable: this class is constructed here and nowhere
 * else; a provider dropping the socket surfaces as ECONNRESET / UND_ERR_SOCKET; a user
 * navigating away surfaces as a DOMException named AbortError carried on the caller's
 * own signal.
 */
export class ProviderDeadlineError extends Error {
  readonly name = "ProviderDeadlineError";
  /** The deadline that elapsed, in ms. */
  readonly deadlineMs: number;
  /** Which deadline it was — the two mean different things. See the constants above. */
  readonly streaming: boolean;

  constructor(deadlineMs: number, streaming: boolean) {
    super(
      streaming
        ? `Provider sent no response headers within ${deadlineMs}ms (streaming deadline)`
        : `Generation did not complete within ${deadlineMs}ms (non-streaming deadline). ` +
          `A non-streamed request sends no response until the whole completion exists, ` +
          `so this deadline covers generation, not just the header phase.`
    );
    this.deadlineMs = deadlineMs;
    this.streaming = streaming;
  }
}

/** True only for a deadline this module imposed. Never true for a provider fault. */
export function isProviderDeadlineError(error: unknown): error is ProviderDeadlineError {
  return error instanceof ProviderDeadlineError;
}

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

  // AN OVERRIDE MAY ONLY LENGTHEN, NEVER CLIP. The descriptor budget answers "this
  // model is slow to first byte" — Kimi's 240s exists for that reason alone. It says
  // nothing about how long a completion takes to generate, so letting it win outright
  // would let a model whose override happened to be 90s reintroduce this exact bug on
  // the non-streaming path. Taking the larger keeps both concerns satisfied at once.
  const requested = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, MIN_OVERRIDE_MS), MAX_OVERRIDE_MS)
    : fallback;

  return { timeoutMs: Math.max(requested, fallback), headers };
}

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Streaming deadline for this deployment. Time to first byte. */
export function providerHeaderTimeoutMs(): number {
  return readTimeoutEnv("AI_PROVIDER_HEADER_TIMEOUT_MS", STREAMING_HEADER_TIMEOUT_MS);
}

/**
 * Non-streaming deadline for this deployment. Total generation time.
 *
 * A SECOND VARIABLE RATHER THAN A BIGGER FIRST ONE. AI_PROVIDER_HEADER_TIMEOUT_MS names
 * a header-phase budget, and the two shapes bound genuinely different things — raising
 * the streaming value to accommodate a slow completion would hand every hung streaming
 * request the same three minutes, which is exactly the protection worth keeping.
 */
export function providerCompletionTimeoutMs(): number {
  return readTimeoutEnv("AI_PROVIDER_COMPLETION_TIMEOUT_MS", NON_STREAMING_COMPLETION_TIMEOUT_MS);
}

/**
 * Did this request ask the provider to stream?
 *
 * Read off the outgoing body because that is where the answer actually is: the AI SDK
 * sends `"stream":true` for streamText and omits it for generateText, and the two go
 * through the same custom fetch from the same adapters. Nothing in `input`, the headers,
 * or the caller identity distinguishes them — every adapter serves both shapes.
 *
 * A BODY THIS CANNOT READ IS TREATED AS STREAMING, which is the tighter of the two
 * deadlines. Guessing "non-streaming" for an unrecognised body would quietly hand three
 * minutes to requests that should be cut off at one, and weakening the hang guard by
 * accident is worse than leaving a rare caller on the deadline it already had.
 */
export function isStreamingRequest(init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (typeof body !== "string") return true;
  return /"stream"\s*:\s*true/.test(body);
}

/** The deadline this request shape needs, before any per-model override. */
export function deadlineFor(init: RequestInit | undefined): number {
  return isStreamingRequest(init) ? providerHeaderTimeoutMs() : providerCompletionTimeoutMs();
}

/**
 * Statuses the fetch spec forbids a body on. Reconstructing one of these with a body —
 * even an empty buffer — throws, so they are returned untouched.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * `fetch`, with a deadline whose MEANING depends on the request shape.
 *
 * STREAMING: a header budget. Headers arriving means tokens are coming, so the clock
 * stops there and the body streams for as long as the generation takes.
 *
 * NON-STREAMING: a total-request budget, covering the body read as well. This is the
 * half that was missing, and the assumption that hid it is written two constants above:
 * that a non-streamed server "writes nothing at all until the entire completion has been
 * generated and it can send a Content-Length". That is true of some providers and false
 * of OpenRouter, which returns headers immediately and then takes as long as it likes
 * over the body. Clearing the timer on headers therefore bounded nothing.
 *
 * MEASURED, which is why this is not a theoretical tidy-up: one generateArtifact call
 * ran 395,342ms against a 180,000ms ceiling and was never aborted. The app had no other
 * bound, so the caller simply waited.
 *
 * The body is buffered rather than wrapped, because for a non-streamed response the body
 * IS the answer and the SDK reads it whole anyway. Buffering costs nothing here and
 * keeps the abort path simple: the timer stays armed across the read, so a stall during
 * the body aborts with the same typed ProviderDeadlineError as a stall before headers,
 * and the gateway classifies it as "deadline" rather than blaming the key.
 *
 * A caller-supplied `init.signal` is still honoured throughout.
 */
export async function fetchWithHeaderTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  defaultTimeoutMs: number = deadlineFor(init)
): Promise<Response> {
  const { timeoutMs, headers } = takeOverride(init, defaultTimeoutMs);
  const controller = new AbortController();
  const callerSignal = init?.signal;

  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  // The reason is a typed error, not a string: it is what lets the gateway tell "we
  // stopped waiting" from "the provider never answered" and leave the key unpunished.
  const streaming = isStreamingRequest(init);
  const timer = setTimeout(() => {
    controller.abort(new ProviderDeadlineError(timeoutMs, streaming));
  }, timeoutMs);

  const cleanup = (): void => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  try {
    const response = await fetch(input, { ...init, headers, signal: controller.signal });

    // Headers are in. For a STREAM that is first-byte, so stop the clock and let a
    // slow-but-alive generation stream for as long as it needs.
    if (streaming) {
      cleanup();
      return response;
    }

    // Non-streamed: the answer has not arrived yet, only the promise of one. Keep the
    // clock running across the body read, so the deadline bounds the whole request.
    if (response.body === null || NULL_BODY_STATUSES.has(response.status)) {
      cleanup();
      return response;
    }

    const buffered = await response.arrayBuffer();
    cleanup();
    return new Response(buffered, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
