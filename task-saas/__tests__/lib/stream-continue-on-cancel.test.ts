import { describe, it, expect, vi } from "vitest";
import { releaseOnStreamEnd } from "@/lib/ai/stream-lifecycle";

/**
 * A disconnect must not cancel the generation.
 *
 * Navigating to another conversation mid-answer surfaces as a cancel on the response
 * body. That used to propagate upstream and abort the provider request, so the SDK's
 * onFinish ran with partial text or never ran, and the reply the user had already paid
 * for was persisted empty — the turn was destroyed by looking away from it.
 *
 * These drive the real ReadableStream machinery rather than a stand-in, because the
 * bug lived precisely in how cancel propagates through it.
 */

/** A source that reports whether it was cancelled, and how much of it was read. */
function trackedSource(chunks: string[]) {
  const state = { cancelled: false, pulled: 0, finished: false };
  let i = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        state.finished = true;
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(new TextEncoder().encode(chunks[i++]));
    },
    cancel() {
      // What used to happen on every navigation away: the upstream torn down.
      state.cancelled = true;
    },
  });

  return { stream, state };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe("stream lifecycle on consumer cancel", () => {
  it("keeps generating after the consumer disconnects", async () => {
    const onSettled = vi.fn();
    const { stream, state } = trackedSource(["a", "b", "c", "d"]);

    const wrapped = releaseOnStreamEnd(new Response(stream), {
      onSettled,
      continueOnCancel: true,
    });

    const reader = wrapped.body!.getReader();
    await reader.read(); // one chunk delivered, then the user navigates away
    await reader.cancel("client disconnected");

    await flush();

    // The upstream was never cancelled, and was drained to its natural end — which is
    // what lets the SDK's onFinish fire and persist the reply.
    expect(state.cancelled).toBe(false);
    expect(state.finished).toBe(true);
    expect(state.pulled).toBe(4);
  });

  it("holds the slot until the generation truly ends, not at disconnect", async () => {
    const onSettled = vi.fn();
    const { stream } = trackedSource(["a", "b", "c"]);

    const wrapped = releaseOnStreamEnd(new Response(stream), {
      onSettled,
      continueOnCancel: true,
    });

    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    // Releasing here would be the accounting failure the module already warns about:
    // real work in flight that the slot count no longer sees.
    expect(onSettled).not.toHaveBeenCalled();

    await flush();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("still cancels upstream when continueOnCancel is off", async () => {
    // The default is unchanged. Callers that genuinely want a cancel still get one.
    const onSettled = vi.fn();
    const { stream, state } = trackedSource(["a", "b", "c"]);

    const wrapped = releaseOnStreamEnd(new Response(stream), { onSettled });

    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    expect(state.cancelled).toBe(true);
    expect(state.finished).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("settles exactly once when a normal drain follows no cancel", async () => {
    const onSettled = vi.fn();
    const { stream } = trackedSource(["a", "b"]);

    const wrapped = releaseOnStreamEnd(new Response(stream), {
      onSettled,
      continueOnCancel: true,
    });

    const reader = wrapped.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    await flush();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("settles once even if a detached drain and the timeout race", async () => {
    // Double-releasing a slot is worse than leaking one: it lets a user exceed their
    // concurrency limit rather than merely under-using it.
    const onSettled = vi.fn();
    const onTimeout = vi.fn();
    const { stream } = trackedSource(["a", "b"]);

    const wrapped = releaseOnStreamEnd(new Response(stream), {
      onSettled,
      onTimeout,
      continueOnCancel: true,
      timeoutMs: 5,
    });

    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    await flush();
    expect(onSettled.mock.calls.length + onTimeout.mock.calls.length).toBe(1);
  });

  it("settles when the upstream errors after a disconnect", async () => {
    // A failed drain is still an ended generation as far as the slot is concerned.
    const onSettled = vi.fn();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i++ === 0) {
          controller.enqueue(new TextEncoder().encode("a"));
          return;
        }
        controller.error(new Error("provider dropped"));
      },
    });

    const wrapped = releaseOnStreamEnd(new Response(stream), {
      onSettled,
      continueOnCancel: true,
    });

    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    await flush();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
