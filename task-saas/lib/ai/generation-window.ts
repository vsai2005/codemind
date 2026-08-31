/**
 * How long one generation may legitimately stay open.
 *
 * Lives here rather than in the chat route because two places need the same number and
 * a route module may only export HTTP methods — importing it from `route.ts` is a build
 * error, so the alternative would be copying the value and letting the copies drift.
 *
 * Two consumers, one meaning:
 *   - the chat route arms a backstop with it, reclaiming a generation slot from a
 *     stream whose client vanished without any terminal signal;
 *   - the conversation endpoint uses it to decide whether a trailing user message with
 *     no reply means "still being answered" or "abandoned".
 *
 * Five minutes because that is longer than any real generation observed, including a
 * Kimi K3 turn that spends ~3 minutes queued before it emits a token. Shortening it
 * would make the UI declare a live generation dead while it is still running.
 */
export const GENERATION_SLOT_MAX_LIFETIME_MS = 5 * 60_000;

/**
 * Is a trailing user message still plausibly being answered?
 *
 * THIS IS A HEURISTIC AND SAYS SO. The user's message is persisted before generation
 * starts, so "last message is from the user" is exactly the in-flight state — but it is
 * also the state left behind by a crash, a deploy, or a failure that never wrote a
 * reply. Nothing distinguishes them from the row alone.
 *
 * Bounding it by the same window the slot backstop uses is what keeps the wrong answer
 * cheap: a crashed turn shows as "working" for at most five minutes rather than
 * forever, and a live turn is never called dead while it is still running. The same
 * trade-off, and the same reasoning, as the idempotency-key window in the chat route.
 */
export function isGenerationPending(
  lastMessageRole: string | null,
  lastMessageCreatedAt: Date | string | null,
  now: number = Date.now()
): boolean {
  if (lastMessageRole !== "user" || lastMessageCreatedAt === null) return false;

  const startedAt = new Date(lastMessageCreatedAt).getTime();
  if (!Number.isFinite(startedAt)) return false;

  const elapsed = now - startedAt;
  // A negative elapsed means clock skew, not a future generation. Treat it as live
  // rather than dead: the row exists, so something wrote it.
  return elapsed < GENERATION_SLOT_MAX_LIFETIME_MS;
}
