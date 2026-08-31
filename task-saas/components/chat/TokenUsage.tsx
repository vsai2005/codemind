"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Running token count for the current conversation, in the chat header.
 *
 * WHAT IT IS AND IS NOT
 * These are counts the PROVIDER reported after answering, read back from stored rows.
 * They are unrelated to `estimateTokens` in lib/ai/context-manager.ts, which guesses
 * BEFORE a request to decide what fits in the window. Showing an estimate here would
 * put a number next to "tokens used" that no provider ever agreed with.
 *
 * Not every turn has one. Usage arrives on the streaming path only when the request
 * set `stream_options.include_usage`, which @ai-sdk/openai sends under
 * `compatibility: "strict"` — NVIDIA and (measured) OpenRouter report, Gemini does
 * not. Unreported turns are COUNTED and shown separately rather than estimated into
 * the total, so the number stays checkable against the provider's own accounting.
 */

interface ConversationUsage {
  totalTokens: number;
  unreportedMessages: number;
}

function parseUsage(body: unknown): ConversationUsage | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.totalTokens !== "number") return null;

  return {
    totalTokens: raw.totalTokens,
    unreportedMessages:
      typeof raw.unreportedMessages === "number" ? raw.unreportedMessages : 0,
  };
}

const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

export function TokenUsage({
  conversationId,
  /** Refetch when this flips false: a turn has finished and its usage is now stored. */
  isStreaming,
}: {
  conversationId: string | null;
  isStreaming: boolean;
}): React.ReactElement | null {
  const [usage, setUsage] = useState<ConversationUsage | null>(null);

  const load = useCallback(async (id: string, signal: AbortSignal) => {
    try {
      const res = await fetch(`/api/conversations/${id}/usage`, { signal });
      if (!res.ok) return;
      const parsed = parseUsage(await res.json());
      if (parsed) setUsage(parsed);
    } catch {
      // A failed read leaves the last good figure rather than blanking the header.
    }
  }, []);

  useEffect(() => {
    if (!conversationId) {
      setUsage(null);
      return;
    }
    // Only once a turn has settled. Reading mid-stream would fetch a total that is
    // about to change and show a stale number as though it were final.
    if (isStreaming) return;

    const controller = new AbortController();
    void load(conversationId, controller.signal);
    return () => controller.abort();
  }, [conversationId, isStreaming, load]);

  // Nothing to report yet — a new conversation, or every turn unreported and no
  // counts at all. An empty readout is better than a confident "0 tokens".
  if (!usage || (usage.totalTokens === 0 && usage.unreportedMessages === 0)) return null;

  // Says CONVERSATION TOTAL explicitly. Without it the figure reads as the cost of the
  // last message, which is what made a 530 beside a two-word reply look wrong — it is
  // cumulative, and every turn resends the system prompt and the history so far.
  const title =
    `${usage.totalTokens.toLocaleString("en-US")} tokens used in this conversation so far` +
    (usage.unreportedMessages > 0
      ? ` · ${usage.unreportedMessages} turn${usage.unreportedMessages === 1 ? "" : "s"} not reported by the provider`
      : "");

  return (
    <span
      title={title}
      className="hidden shrink-0 items-center gap-1.5 rounded-card border border-gray-200 bg-white px-2.5 py-1 text-[12px] tabular-nums text-gray-500 sm:inline-flex"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-gray-400">
        <path d="M12 20V10M18 20V4M6 20v-4" />
      </svg>
      {usage.totalTokens > 0 ? (
        <span>{compact(usage.totalTokens)} tokens</span>
      ) : (
        <span>usage not reported</span>
      )}
      {usage.unreportedMessages > 0 && usage.totalTokens > 0 && (
        // The gap, stated rather than hidden. Without it a Gemini-heavy conversation
        // reads as though it barely used anything.
        <span className="text-gray-400">+{usage.unreportedMessages} n/r</span>
      )}
    </span>
  );
}
