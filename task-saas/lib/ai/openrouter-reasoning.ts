/**
 * Bound the reasoning pass on OpenRouter requests.
 *
 * WHY THIS EXISTS, measured on 2026-09-03 against `z-ai/glm-5.3-flash` by calling
 * OpenRouter's HTTP API directly, so nothing was mapped or renamed on the way back:
 *
 *   no reasoning field, max_tokens 2000 -> reasoning_tokens 1999, content 0 chars
 *   no reasoning field, max_tokens 8000 -> reasoning_tokens 8000, content 0 chars
 *   reasoning {effort:"low"}            -> reasoning_tokens    0, content 3366 chars
 *   reasoning {max_tokens:512}          -> reasoning_tokens    0, content 5154 chars
 *
 * The model spends its whole completion budget thinking and returns an empty string, and
 * a bigger budget is simply eaten too. Disabling is refused by the provider
 * (400 "Reasoning is mandatory for this endpoint"), so constraining it is the only lever.
 *
 * WHY A FETCH-LEVEL BODY EDIT. `@ai-sdk/openai` at 0.0.66 offers no per-call channel for
 * a non-OpenAI field, and the provider instance is constructed once and shared. The
 * adapter already owns its `fetch`, and the header-timeout override travels the same way
 * for the same reason.
 *
 * FAILS OPEN, deliberately. Anything unexpected -- a non-string body, a body that is not
 * JSON, a request that already carries `reasoning` -- is passed through untouched. A
 * request that reaches the provider slightly unoptimised is recoverable; one this
 * function corrupted is not.
 */

/**
 * A HARD TOKEN CAP IS THE DEFAULT LEVER, and this is which of the two won.
 *
 * Both `{effort:"low"}` and `{max_tokens:512}` drove reasoning_tokens to zero, so the
 * choice was made on the real path rather than on the raw probe. Measured through
 * generateArtifact, wall time per run:
 *
 *   single-debounce   effort=low      15,294ms PASS | 180,039ms FAILED on the deadline
 *   single-debounce   max_tokens=512  10,515ms PASS |  23,075ms PASS
 *   zip-large-ecom    effort=low     103,839ms      | 120,320ms | 129,617ms
 *   zip-large-ecom    max_tokens=512 121,331ms      | 106,661ms
 *
 * The large case is a wash. The small case is not: `effort` produced the only run that
 * reached the 180s ceiling, and the cap was roughly six times faster on average there.
 *
 * THE SAMPLE IS TWO TO THREE RUNS PER CELL, because each large run costs about two
 * minutes of paid inference. One timeout is not proof that `effort` causes timeouts —
 * it may be ordinary provider variance. The tie-breaker is therefore a property rather
 * than a p-value: a token cap is a NUMBER the provider must honour, while "low" is a
 * qualitative hint each model is free to read differently. A deployment that adds a
 * second OpenRouter model inherits a predictable ceiling from the first and a guess from
 * the second.
 *
 * OPENROUTER_REASONING_MAX_TOKENS overrides the number.
 * OPENROUTER_REASONING_EFFORT overrides the whole lever: "low" | "medium" | "high" to
 * send an effort instead, or "off" to send no reasoning field at all and reproduce the
 * empty-output failure above without editing code.
 */
export const DEFAULT_REASONING_MAX_TOKENS = 512;

/** Values accepted for OPENROUTER_REASONING_EFFORT. */
const EFFORTS = new Set(["low", "medium", "high", "off"]);

/**
 * An explicit effort override, or null when the variable is unset or unrecognised.
 *
 * Kept distinct from "the resolved setting" on purpose: `withReasoningBudget` has to
 * tell "not configured" apart from "configured to low", or the measured default above
 * could never be reached while a stale variable happened to be exported from an earlier
 * manual test.
 */
export function reasoningEffortOverride(): string | null {
  const raw = (process.env.OPENROUTER_REASONING_EFFORT ?? "").trim().toLowerCase();
  return EFFORTS.has(raw) ? raw : null;
}

/**
 * A floor under the override, against typos rather than against a considered choice.
 *
 * Below this a cap cannot express a single sentence of reasoning, so a value under it is
 * far more likely a slip than an intention -- and it would be a slip with teeth, since a
 * three-token budget produces the same empty output this module exists to prevent.
 */
const MIN_REASONING_MAX_TOKENS = 64;

/**
 * The reasoning token cap in force: the env override, or the measured default.
 *
 * PARSED STRICTLY, and a test caught why. `Number.parseInt("3.7", 10)` is 3, which is a
 * positive integer and would have shipped a three-token reasoning budget on every
 * request. Number() rejects the whole string instead, and the floor below catches the
 * rest.
 */
export function reasoningMaxTokens(): number {
  const text = (process.env.OPENROUTER_REASONING_MAX_TOKENS ?? "").trim();
  if (text.length === 0) return DEFAULT_REASONING_MAX_TOKENS;

  const value = Number(text);
  const usable = Number.isInteger(value) && value >= MIN_REASONING_MAX_TOKENS;
  return usable ? value : DEFAULT_REASONING_MAX_TOKENS;
}

/**
 * Add a reasoning budget to an outgoing OpenRouter request body.
 *
 * Returns the init unchanged when there is nothing safe to do.
 */
export function withReasoningBudget(init: RequestInit | undefined): RequestInit | undefined {
  const override = reasoningEffortOverride();
  if (override === "off") return init;

  const body = init?.body;
  if (typeof body !== "string" || body.length === 0) return init;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return init;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return init;

  const payload = parsed as Record<string, unknown>;
  // A caller that set this deliberately outranks both the override and the default.
  if ("reasoning" in payload) return init;

  const reasoning =
    override === null ? { max_tokens: reasoningMaxTokens() } : { effort: override };

  return { ...init, body: JSON.stringify({ ...payload, reasoning }) };
}
