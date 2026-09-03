"use client";

/**
 * The banner shown when a turn fails.
 *
 * It exists because a failure used to be completely invisible. `useChat` calls its
 * internal `restoreMessagesOnFailure()` on any non-2xx, which REMOVES the message the
 * user just sent from the transcript, and neither chat page rendered the `error` it
 * sets. The message vanished from the screen, nothing replaced it, and because the
 * route persists the user message before generation starts, it reappeared on the next
 * reload — so the app looked like it was silently eating messages.
 *
 * That silence also hid the real cause. A user hitting the concurrency limit was
 * getting an instant 429 saying exactly what was wrong, and never saw a word of it.
 */

/**
 * Pull the human sentence out of whatever the SDK surfaced.
 *
 * Every failure this route returns is JSON — `{"error": "..."}` — and the AI SDK puts
 * the raw response body into `error.message`. Parsing it back out is what turns
 * `{"error":"You already have 3 responses in progress..."}` into something a person can
 * act on. Anything unparseable (a network drop, an HTML error page from a proxy) falls
 * back to a plain sentence rather than showing a stack trace or an empty box.
 */
export function describeChatError(error: Error): string {
  const raw = (error.message ?? "").trim();
  if (raw.length === 0) return "Something went wrong sending that message.";

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const message = (parsed as { error: unknown }).error;
      if (typeof message === "string" && message.trim().length > 0) return message.trim();
    }
  } catch {
    // Not JSON. Fall through to the raw text if it looks like prose rather than markup.
  }

  // A body that starts with a tag is a proxy or framework error page, not a message
  // meant for this user.
  if (raw.startsWith("<")) return "Something went wrong sending that message.";
  return raw;
}

/**
 * Is this the conversation itself being gone, rather than the turn failing?
 *
 * A DIFFERENT KIND OF FAILURE, and the only one where Retry cannot ever help. Every
 * other error here is worth resending: a rate limit passes, a provider recovers, a
 * timeout may not repeat. A conversation that no longer exists will 404 identically
 * forever, so offering Retry as the sole action leaves the user pressing a button that
 * is guaranteed not to work, with no way out of that screen.
 *
 * Matched on the route's own message rather than a status code, because the AI SDK
 * hands this layer a response BODY and not a status. The route returns
 * `{"error":"Conversation not found or unauthorized"}` with a 404.
 */
export function isConversationGone(error: Error): boolean {
  return /conversation not found/i.test(describeChatError(error));
}

interface ChatErrorProps {
  error: Error;
  /** Resends whatever failed. */
  onRetry: () => void;
  /** True while another generation is running, so retry cannot stack requests. */
  disabled?: boolean;
  /**
   * Reassurance line under the message. Defaults to the chat-send wording; a caller
   * reusing this banner for a different failure (upload, for instance) should say what
   * was actually preserved instead — "your message" is wrong when nothing was sent.
   */
  hint?: string;
  /**
   * Starts a fresh conversation. Offered INSTEAD of Retry when the conversation is
   * gone, since resending cannot succeed and leaving only Retry strands the user.
   */
  onStartNewChat?: () => void;
}

export function ChatError({
  error,
  onRetry,
  disabled = false,
  hint = "Your message was not lost — it is back in the box below.",
  onStartNewChat,
}: ChatErrorProps): React.ReactElement {
  // Only swap the action when there is somewhere to send the user. A caller that gave
  // no handler keeps the ordinary banner rather than losing its only control.
  const gone = isConversationGone(error) && onStartNewChat !== undefined;
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-3xl items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="mt-0.5 h-4 w-4 shrink-0 text-red-500"
      >
        <path
          fillRule="evenodd"
          d="M18 10A8 8 0 112 10a8 8 0 0116 0zm-9-4a1 1 0 112 0v4a1 1 0 11-2 0V6zm1 8a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-relaxed text-red-900">{describeChatError(error)}</p>
        <p className="mt-1 text-[12px] text-red-700">
          {gone
            ? "This conversation no longer exists. Your message is still in the box below — start a new chat and send it there."
            : hint}
        </p>
      </div>

      <button
        type="button"
        onClick={gone ? onStartNewChat : onRetry}
        disabled={disabled && !gone}
        className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-1.5 text-[12px] font-medium text-red-900 transition-colors hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {gone ? "Start a new chat" : "Retry"}
      </button>
    </div>
  );
}
