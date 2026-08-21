/**
 * Tie a resource's lifetime to a streaming Response body.
 *
 * `fetch` resolves when headers arrive, but a generation keeps the connection busy for
 * as long as it streams. Anything reserved for the duration of a request — a provider
 * key lease, a per-user concurrency slot — must therefore be released from the body,
 * not from the promise that produced it.
 *
 * Three terminal paths exist and all must release exactly once:
 *   - the stream drains normally,
 *   - the stream errors mid-flight,
 *   - the consumer cancels (which is how a browser disconnect surfaces).
 */

export interface StreamLifecycleOptions {
  /** Runs exactly once when the stream settles, however it settles. */
  onSettled: () => void;
  /**
   * Backstop for a stream abandoned without any terminal signal (a platform-level
   * timeout severing the socket). Set 0 to disable.
   */
  timeoutMs?: number;
  /** Called instead of onSettled when the timeout fires, so callers can distinguish. */
  onTimeout?: () => void;
}

/**
 * Wrap `response` so `onSettled` fires when its body finishes, errors, or is cancelled.
 *
 * The returned Response preserves status, statusText and every header — losing
 * `Content-Type: text/event-stream` here would silently break SSE parsing downstream.
 */
export function releaseOnStreamEnd(
  response: Response,
  options: StreamLifecycleOptions
): Response {
  const { onSettled, timeoutMs = 0, onTimeout } = options;

  if (!response.body) {
    onSettled();
    return response;
  }

  const reader = response.body.getReader();
  let settled = false;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    onSettled();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Cancel the upstream read as well. Releasing the slot without closing the
      // socket would leave real work in flight that the accounting no longer sees,
      // which is worse than holding the slot.
      void reader.cancel("codemind: stream lifetime exceeded").catch(() => undefined);
      (onTimeout ?? onSettled)();
    }, timeoutMs);
    // A pending timer must not keep the process alive.
    timer.unref?.();
  }

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason);
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
