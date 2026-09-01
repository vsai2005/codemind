/**
 * Circuit breaker for the measurement harness.
 *
 * THE RUN THIS EXISTS BECAUSE OF
 * A 42-case measurement produced 42 consecutive generation failures — every one
 * "Too Many Requests" — after 126 retries and 11,864 seconds of deliberate waiting.
 * Three hours and twenty minutes, a full daily allowance, and not one artifact. The
 * harness had no notion of "this run cannot succeed", so it worked through the entire
 * case list failing identically.
 *
 * BURST VERSUS QUOTA, AND WHY THIS IS A HEURISTIC
 * Backoff is the right answer to burst limiting, where waiting lets a window roll over.
 * It is useless against quota exhaustion, where the allowance is spent and nothing
 * recovers until a reset the caller cannot see. The two are indistinguishable here:
 * lib/ai/failure-classification.ts does parse a retry-after out of a 429 body, but that
 * classification never leaves the gateway — generateArtifact returns a scrubbed string —
 * and the provider supplied no such value anyway. All 42 messages were byte-identical.
 *
 * So the distinction is made by behaviour rather than by a header that was never sent:
 * one full backoff cycle tests the burst hypothesis, and if a second turn hits the same
 * wall, the hypothesis is wrong and further waiting is just slower failure.
 */

/**
 * Consecutive same-classification failures before the run aborts.
 *
 * Three, and the bound is squeezed from both sides.
 *
 * NOT LOWER: each failing turn has already exhausted its own retries, so three turns is
 * roughly twelve provider rejections spread across several minutes of backoff. The worst
 * transient blip actually observed was TWO consecutive failures followed by a success —
 * the second arm of an earlier run recovered exactly that way — so a limit of two would
 * have aborted a run that went on to produce data.
 *
 * NOT HIGHER: the cost of continuing is measured in hours. On the run that prompted
 * this, stopping at three would have ended it in about four minutes instead of three
 * hours and twenty.
 *
 * The asymmetry decides it. Tripping early costs one re-run; tripping late costs an
 * afternoon and the day's allowance.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 3;

/** How a generation failure is bucketed for breaker purposes. */
export type FailureKind = "rate-limit" | "transport";

export interface BreakerState {
  /** Consecutive failures of `kind`. Reset by any success. */
  consecutive: number;
  /** The classification being counted, or null when nothing is being counted. */
  kind: FailureKind | null;
  /** Set once the limit is reached. Terminal — the run stops. */
  tripped: boolean;
  /** Why it tripped, for the report. Null until it does. */
  reason: string | null;
}

export function initialBreaker(): BreakerState {
  return { consecutive: 0, kind: null, tripped: false, reason: null };
}

/**
 * A success clears the counter completely.
 *
 * CONSECUTIVE is the signal, not total. A run that alternates failure and success is
 * hitting a flaky provider and is still producing data; a run that fails three times in
 * a row is not producing anything. Counting totals would abort the first kind of run,
 * which is exactly the kind worth finishing.
 */
export function recordSuccess(state: BreakerState): BreakerState {
  if (state.tripped) return state;
  return { consecutive: 0, kind: null, tripped: false, reason: null };
}

/**
 * Record a generation failure, tripping the breaker at the limit.
 *
 * A failure of a DIFFERENT classification restarts the count at one rather than adding
 * to it. Two rate limits and a transport stall are not three of anything — they are a
 * provider having two separate problems, and treating them as one signal would abort on
 * evidence that does not point anywhere in particular.
 */
export function recordFailure(state: BreakerState, kind: FailureKind): BreakerState {
  if (state.tripped) return state;

  const consecutive = state.kind === kind ? state.consecutive + 1 : 1;
  if (consecutive < CONSECUTIVE_FAILURE_LIMIT) {
    return { consecutive, kind, tripped: false, reason: null };
  }

  return {
    consecutive,
    kind,
    tripped: true,
    reason:
      kind === "rate-limit"
        ? `${consecutive} consecutive rate-limited generations with no success. ` +
          `Backoff cannot clear an exhausted quota, so the run was stopped rather than ` +
          `spending the remaining cases on the same failure.`
        : `${consecutive} consecutive transport failures with no success. ` +
          `The provider is not answering, so the remaining cases would measure nothing.`,
  };
}

/**
 * How many attempts this turn should make, given what the run has already seen.
 *
 * The first rate-limited turn gets the full allowance: that is the experiment which
 * tests whether waiting helps. Once a turn has already spent a complete backoff cycle
 * and the next one is rate-limited again, waiting has been shown not to help, so
 * further attempts are charged against a quota rather than testing anything.
 *
 * Transport failures keep their retries throughout — a stalled connection genuinely does
 * recover on a timescale retrying can reach.
 */
export function attemptsFor(
  state: BreakerState,
  kind: FailureKind,
  maxAttempts: number
): number {
  if (kind === "rate-limit" && state.kind === "rate-limit" && state.consecutive >= 1) {
    return 1;
  }
  return maxAttempts;
}
