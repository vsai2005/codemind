import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchWithHeaderTimeout,
  HEADER_TIMEOUT_HEADER,
} from "@/lib/ai/fetch-timeout";

/**
 * Per-model header-phase timeout.
 *
 * WHY THIS EXISTS AT ALL
 * Time-to-headers is a property of the model, not the deployment. Measured on NVIDIA's
 * endpoint: Nemotron sends headers in 0.4s, Kimi K3 in ~175s because it buffers its
 * whole reasoning pass first. A single global number cannot serve both — at 60s Kimi
 * can never answer, and at 240s a genuinely hung request holds a generation slot for
 * four minutes instead of one.
 *
 * THE TWO PROPERTIES WORTH PROTECTING
 *   1. The override actually lengthens the wait for the model that asked for it, and
 *      does NOT lengthen it for anything else. If the plumbing silently dropped the
 *      header, Kimi would go back to 504ing after burning three API keys, and every
 *      test asserting "it times out" would still pass.
 *   2. The marker header never reaches the provider. It is an instruction to this
 *      module; forwarding it leaks an internal knob into an outbound API call.
 */
describe("header timeout override", () => {
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

  /** A fetch that only ever ends by abort, the way a stalled provider behaves. */
  const hangingFetch = () =>
    fetchMock.mockImplementation(
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted"))
          );
        })
    );

  it("waits the model's own budget instead of the default", async () => {
    hangingFetch();

    const promise = fetchWithHeaderTimeout(
      "https://example.test/v1/chat/completions",
      { headers: { [HEADER_TIMEOUT_HEADER]: "240000" } },
      60_000
    );
    const settled = promise.then(
      () => "resolved",
      (e: Error) => e.message
    );

    // Past the 60s default. A dropped override would have aborted by now, and Kimi's
    // 175s time-to-headers would be unreachable.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(121_000);
    expect(await settled).toContain("240000");
  });

  it("still enforces the default for a model that asks for nothing", async () => {
    hangingFetch();

    const settled = fetchWithHeaderTimeout(
      "https://example.test/v1/chat/completions",
      { headers: { "content-type": "application/json" } },
      60_000
    ).then(
      () => "resolved",
      (e: Error) => e.message
    );

    await vi.advanceTimersByTimeAsync(61_000);
    // The whole point of keeping the default tight: one slow model must not buy every
    // other provider four minutes of hanging.
    expect(await settled).toContain("60000");
  });

  it("strips the marker before the request leaves", async () => {
    fetchMock.mockResolvedValue(new Response("ok"));

    await fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {
      headers: {
        [HEADER_TIMEOUT_HEADER]: "240000",
        authorization: "Bearer secret-value",
      },
    });

    const sent = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(sent.get(HEADER_TIMEOUT_HEADER)).toBeNull();
    // Everything else survives — stripping must not clobber the credential the
    // scheduler just set.
    expect(sent.get("authorization")).toBe("Bearer secret-value");
  });

  it("clamps a value that would disable the guard", async () => {
    hangingFetch();

    const settled = fetchWithHeaderTimeout(
      "https://example.test/v1/chat/completions",
      { headers: { [HEADER_TIMEOUT_HEADER]: "999999999" } },
      60_000
    ).then(
      () => "resolved",
      (e: Error) => e.message
    );

    // Ceiling is five minutes. Without the clamp a careless caller could park a
    // generation slot for eleven days.
    await vi.advanceTimersByTimeAsync(301_000);
    expect(await settled).toContain("300000");
  });

  it("falls back to the default when the value is not a number", async () => {
    hangingFetch();

    const settled = fetchWithHeaderTimeout(
      "https://example.test/v1/chat/completions",
      { headers: { [HEADER_TIMEOUT_HEADER]: "soon" } },
      60_000
    ).then(
      () => "resolved",
      (e: Error) => e.message
    );

    await vi.advanceTimersByTimeAsync(61_000);
    expect(await settled).toContain("60000");
  });
});
