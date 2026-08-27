import { logger } from "@/lib/logger";

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
  /**
   * Keep the generation running when the CONSUMER goes away.
   *
   * A browser disconnect — navigating to another conversation, closing the tab —
   * surfaces here as a cancel on the response body. Propagating it upstream aborts the
   * provider request mid-sentence, so the SDK's onFinish either never runs or runs
   * with partial text, and the turn the user paid for is persisted empty or not at
   * all. Switching conversations while an answer was being written destroyed it.
   *
   * With this set, a cancel DETACHES instead: the upstream keeps being drained to
   * completion so onFinish still fires and still writes the reply, and the user finds
   * it waiting when they come back.
   *
   * The slot is deliberately NOT released at that point. Real work is still in flight,
   * and releasing while it runs is the accounting failure this module's timeout
   * comment already warns about. `timeoutMs` remains the outer bound.
   */
  continueOnCancel?: boolean;
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
  const { onSettled, timeoutMs = 0, onTimeout, continueOnCancel = false } = options;

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
      if (!continueOnCancel) {
        settle();
        return reader.cancel(reason);
      }

      /**
       * The consumer left; the generation has not. Detach and keep reading.
       *
       * Bytes are discarded — nobody is listening for them — but reading is what
       * drives the upstream to completion, and completion is what makes the SDK fire
       * onFinish and persist the reply. Returning without cancelling is the whole
       * point: `reader.cancel` here is exactly what used to kill the answer.
       *
       * `settle` runs only when the upstream genuinely ends, so the slot stays held
       * for as long as real work continues. The timeout above is still armed and is
       * what stops a wedged generation holding it forever.
       */
      const detachedAt = Date.now();
      void (async () => {
        let chunks = 0;
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
            chunks++;
          }
          // Logged because a detached generation is otherwise invisible: nothing is
          // reading it, so the only evidence it ran to completion is the persisted
          // reply appearing later. Confirming the drain finished is what separates
          // "the fix is working" from "the reply is missing for another reason" —
          // measured at 391 chunks over 90s on a real disconnect.
          logger.debug("Detached stream drained after client disconnect", {
            chunks,
            elapsedMs: Date.now() - detachedAt,
          });
        } catch (error) {
          // A failed drain is still an ended generation as far as accounting goes.
          logger.warn("Detached stream failed after client disconnect", {
            chunks,
            elapsedMs: Date.now() - detachedAt,
            error: error instanceof Error ? error.message : "unknown",
          });
        } finally {
          settle();
        }
      })();

      return Promise.resolve();
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
