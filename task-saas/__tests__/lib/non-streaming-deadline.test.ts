import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deadlineFor,
  fetchWithHeaderTimeout,
  isStreamingRequest,
  providerCompletionTimeoutMs,
  providerHeaderTimeoutMs,
  HEADER_TIMEOUT_HEADER,
} from "@/lib/ai/fetch-timeout";

/**
 * Two request shapes, two deadlines.
 *
 * THE DEFECT THIS PINS DOWN
 * The timer is cleared when `fetch()` resolves — when response HEADERS arrive. On a
 * streamed request that is time-to-first-byte, well under a second. On a NON-streamed
 * one the server writes nothing until the whole completion exists, so the very same
 * constant stopped being a header budget and became a ceiling on total generation time.
 * Every artifact generation running past 60s was aborted regardless of provider health,
 * and the error still read "sent no response headers", which sent the diagnosis in
 * precisely the wrong direction.
 *
 * THE DEADLINES IN THESE FIXTURES DIFFER BY CONSTRUCTION, 60s versus 180s. A fixture
 * where both shapes share a deadline returns the same answer under a correct selection
 * and under a swapped one, so it could not tell them apart. Every assertion below names
 * the shape it expects AND a number only that shape produces.
 */

const STREAMING = 60_000;
const NON_STREAMING = 180_000;

const ENV_STREAM = "AI_PROVIDER_HEADER_TIMEOUT_MS";
const ENV_COMPLETION = "AI_PROVIDER_COMPLETION_TIMEOUT_MS";

/** Bodies exactly as the AI SDK writes them. */
const streamingBody = JSON.stringify({ model: "m", messages: [], stream: true });
const nonStreamingBody = JSON.stringify({ model: "m", messages: [], max_tokens: 8192 });

describe("choosing a deadline from the request shape", () => {
  let savedStream: string | undefined;
  let savedCompletion: string | undefined;

  beforeEach(() => {
    savedStream = process.env[ENV_STREAM];
    savedCompletion = process.env[ENV_COMPLETION];
    delete process.env[ENV_STREAM];
    delete process.env[ENV_COMPLETION];
  });

  afterEach(() => {
    if (savedStream === undefined) delete process.env[ENV_STREAM];
    else process.env[ENV_STREAM] = savedStream;
    if (savedCompletion === undefined) delete process.env[ENV_COMPLETION];
    else process.env[ENV_COMPLETION] = savedCompletion;
  });

  it("reads streamText's body as streaming and generateText's as not", () => {
    expect(isStreamingRequest({ body: streamingBody })).toBe(true);
    expect(isStreamingRequest({ body: nonStreamingBody })).toBe(false);
  });

  it("is not fooled by the word stream appearing elsewhere", () => {
    // A prompt about streaming, or a model id containing it, must not flip the shape.
    const prompt = JSON.stringify({
      model: "stream-2",
      messages: [{ role: "user", content: 'explain "stream": true in SSE' }],
    });

    expect(isStreamingRequest({ body: prompt })).toBe(false);
  });

  it("treats stream:false as non-streaming", () => {
    expect(isStreamingRequest({ body: JSON.stringify({ stream: false }) })).toBe(false);
  });

  it("treats an unreadable body as streaming, the TIGHTER deadline", () => {
    // Guessing non-streaming here would quietly hand three minutes to requests that
    // should be cut off at one. Weakening the hang guard by accident is the worse error.
    expect(isStreamingRequest(undefined)).toBe(true);
    expect(isStreamingRequest({})).toBe(true);
    expect(isStreamingRequest({ body: new Uint8Array([1, 2, 3]) })).toBe(true);
  });

  it("hands each shape its own number", () => {
    expect(deadlineFor({ body: streamingBody })).toBe(STREAMING);
    expect(deadlineFor({ body: nonStreamingBody })).toBe(NON_STREAMING);
  });

  it("keeps the chat deadline at exactly 60 seconds", () => {
    // The value, spelled out. This fix must not have bought the streaming path any
    // extra rope — that 60s is the whole protection against a provider that accepts a
    // connection and never answers.
    expect(providerHeaderTimeoutMs()).toBe(60_000);
    expect(deadlineFor({ body: streamingBody })).toBe(60_000);
  });

  it("gives each shape its own env var", () => {
    process.env[ENV_COMPLETION] = "90000";

    expect(providerCompletionTimeoutMs()).toBe(90_000);
    // The streaming side is untouched by it.
    expect(providerHeaderTimeoutMs()).toBe(60_000);
    expect(deadlineFor({ body: streamingBody })).toBe(60_000);
    expect(deadlineFor({ body: nonStreamingBody })).toBe(90_000);
  });

  it("does not let the streaming var move the non-streaming deadline", () => {
    process.env[ENV_STREAM] = "5000";

    expect(deadlineFor({ body: streamingBody })).toBe(5000);
    expect(deadlineFor({ body: nonStreamingBody })).toBe(NON_STREAMING);
  });
});

describe("the deadline in effect", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A provider that never answers, the way a stalled endpoint behaves. */
  const hangingFetch = () =>
    fetchMock.mockImplementation(
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted"))
          );
        })
    );

  /** A provider that answers, but only after `ms` — a long non-streamed completion. */
  const slowFetch = (ms: number) =>
    fetchMock.mockImplementation(
      (_input: unknown, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response("ok")), ms);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        })
    );

  const settle = (p: Promise<Response>) =>
    p.then(
      () => "resolved",
      (e: Error) => e.message
    );

  it("lets a non-streaming call run past the streaming deadline and succeed", async () => {
    // THE WHOLE POINT. 90s is beyond the 60s streaming budget and inside the 180s
    // completion budget. Before this fix the same request aborted at 60s with a message
    // blaming the provider for sending no headers.
    slowFetch(90_000);

    const settled = settle(
      fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
        body: nonStreamingBody,
      })
    );

    await vi.advanceTimersByTimeAsync(61_000);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled).toBe("resolved");
  });

  it("still aborts a hung non-streaming call at its own deadline", async () => {
    // Longer is not unlimited. The guard still exists; it is just correctly sized.
    hangingFetch();

    const settled = settle(
      fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
        body: nonStreamingBody,
      })
    );

    await vi.advanceTimersByTimeAsync(179_000);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toContain("180000");
  });

  it("still aborts a hung streaming call at sixty seconds", async () => {
    // The chat path's protection, unchanged and asserted at its exact value.
    hangingFetch();

    const settled = settle(
      fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
        body: streamingBody,
      })
    );

    await vi.advanceTimersByTimeAsync(61_000);
    expect(await settled).toContain("60000");
  });

  it("does not give a streaming call the longer budget", async () => {
    // A swapped selection passes every "it eventually aborts" test ever written. This
    // one fails immediately, because at 61s the streaming call must already be dead.
    hangingFetch();

    const settled = settle(
      fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
        body: streamingBody,
      })
    );

    await vi.advanceTimersByTimeAsync(61_000);
    expect(await settled).not.toBe("pending");
    expect(await settled).not.toContain("180000");
  });

  it("lets a model's own override lengthen a streaming call", async () => {
    // Kimi's 240s, still winning where it is set.
    hangingFetch();

    const settled = settle(
      fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
        body: streamingBody,
        headers: { [HEADER_TIMEOUT_HEADER]: "240000" },
      })
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(121_000);
    expect(await settled).toContain("240000");
  });

  it("never lets an override CLIP the shape's own deadline", async () => {
    // A descriptor override says "this model is slow to first byte". It says nothing
    // about generation time, so a model whose override happened to be 90s must not drag
    // the non-streaming deadline back down to 90s and reintroduce this exact bug.
    hangingFetch();

    const settled = settle(
      fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
        body: nonStreamingBody,
        headers: { [HEADER_TIMEOUT_HEADER]: "90000" },
      })
    );

    await vi.advanceTimersByTimeAsync(91_000);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(90_000);
    expect(await settled).toContain("180000");
  });

  it("keeps an explicit caller-supplied default authoritative", async () => {
    // The third argument is how the existing tests pin a deadline. Shape selection is
    // the DEFAULT for that parameter, so passing one must still win.
    hangingFetch();

    const settled = settle(
      fetchWithHeaderTimeout(
        "https://example.test/v1/chat/completions",
        { body: nonStreamingBody },
        30_000
      )
    );

    await vi.advanceTimersByTimeAsync(31_000);
    expect(await settled).toContain("30000");
  });
});
