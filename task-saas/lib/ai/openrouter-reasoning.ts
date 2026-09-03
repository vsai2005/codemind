/**
 * Bound the reasoning pass on OpenRouter requests.
 *
 * WHY THIS EXISTS, measured on 2026-09-03 against `z-ai/glm-5.3-flash` by calling
 * OpenRouter's HTTP API directly, with nothing mapped or renamed on the way back:
 *
 *   no reasoning field, max_tokens 2000 -> reasoning_tokens 1999, content 0 chars, length
 *   no reasoning field, max_tokens 8000 -> reasoning_tokens 8000, content 0 chars, length
 *   reasoning {effort:"low"}, mt 4000   -> reasoning_tokens    0, content 3366 chars, stop
 *   reasoning {max_tokens:512}, mt 4000 -> reasoning_tokens    0, content 5154 chars, stop
 *
 * The model spends its ENTIRE completion budget thinking and emits nothing visible, and
 * raising the budget does not help because the reasoning grows to fill it. That is what
 * produced a 16,000-token artifact generation returning an empty string with
 * finishReason "length".
 *
 * `{"reasoning":{"enabled":false}}` is NOT the fix: OpenRouter answers
 * `400 Reasoning is mandatory for this endpoint and cannot be disabled`. Constraining it
 * is accepted where disabling it is refused.
 *
 * WHY A FETCH-LEVEL BODY EDIT. `@ai-sdk/openai` at 0.0.66 offers no per-call channel for
 * a non-OpenAI field, and the provider instance is constructed once and shared. The
 * adapter already owns its `fetch`, and the header-timeout override travels the same way
 * for the same reason.
 *
 * FAILS OPEN, deliberately. Anything unexpected — a non-string body, a body that is not
 * JSON, a request that already carries `reasoning` — is passed through untouched. A
 * request that reaches the provider slightly unoptimised is recoverable; one this
 * function corrupted is not.
 */

/** Values accepted for OPENROUTER_REASONING_EFFORT. "off" skips injection entirely. */
const EFFORTS = new Set(["low", "medium", "high", "off"]);

/**
 * "low" by default, which measured `reasoning_tokens: 0` and a complete answer.
 *
 * Set OPENROUTER_REASONING_EFFORT=off to send nothing and get the provider's own
 * behaviour back — the state this module exists to correct, kept reachable so the
 * measurement can be reproduced without editing code.
 */
export function reasoningEffort(): string {
  const raw = (process.env.OPENROUTER_REASONING_EFFORT ?? "").trim().toLowerCase();
  return EFFORTS.has(raw) ? raw : "low";
}

/**
 * Add a reasoning budget to an outgoing OpenRouter request body.
 *
 * Returns the init unchanged when there is nothing safe to do.
 */
export function withReasoningBudget(init: RequestInit | undefined): RequestInit | undefined {
  const effort = reasoningEffort();
  if (effort === "off") return init;

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
  // A caller that set this deliberately outranks the default.
  if ("reasoning" in payload) return init;

  return { ...init, body: JSON.stringify({ ...payload, reasoning: { effort } }) };
}
