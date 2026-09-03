import { generateText } from "ai";
import { resolveModel } from "@/lib/ai/models/registry";
import { getIntentTimeoutMs } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Rewrite a user's draft into a clearer request, for the composer's Enhance action.
 *
 * ENTIRELY SEPARATE FROM GENERATION. Nothing here touches the chat pipeline, intent
 * detection or context assembly. The only thing this produces is text that goes back
 * into the composer's input state, where the user reads it and decides. It cannot send,
 * and there is deliberately no code path in which it does.
 *
 * FAILS CLOSED, AND "CLOSED" MEANS UNCHANGED. Timeout, outage, refusal, an empty answer
 * — every one returns the original draft with `status: "failed"`. The caller must show
 * the user their own words, never a silent substitution: a rewrite the user did not see
 * happen is worse than no rewrite, because they would send it believing it was theirs.
 */

/** What the enhancer concluded. The three are handled differently by the UI. */
export type EnhanceStatus = "enhanced" | "needs-clarification" | "failed";

export interface EnhanceResult {
  status: EnhanceStatus;
  /** The rewrite for "enhanced"; the ORIGINAL text, unchanged, for the other two. */
  text: string;
  /** Present only for "needs-clarification": why no honest rewrite was possible. */
  reason?: string;
}

/**
 * The registry entry this uses. Internal, so it never appears in the model picker.
 *
 * Not the intent classifier's model: that one is NVIDIA-hosted and this deployment has
 * no NVIDIA key. See the registry entry for the re-run search.
 */
export const ENHANCER_MODEL_ID = "ministral-3b";

/**
 * Output ceiling for a rewrite.
 *
 * A REQUEST, NOT AN ESSAY. 120 tokens is roughly two sentences, which is the shape the
 * prompt asks for, and a model that starts writing a specification gets cut off rather
 * than filling the composer with something the user has to delete. Deliberately far
 * below SUMMARY_MAX_OUTPUT_TOKENS (1024) and PLAN_MAX_OUTPUT_TOKENS (900): those produce
 * documents, this produces one line someone is about to edit.
 */
export const ENHANCER_MAX_OUTPUT_TOKENS = 120;

/** Longest draft worth sending. Beyond this the user has already been specific. */
export const ENHANCER_MAX_INPUT_CHARS = 2_000;

/**
 * A draft with no subject to enhance.
 *
 * DECIDED IN CODE, NOT BY THE MODEL, and that is the safety property of this whole
 * feature rather than an optimisation.
 *
 * MEASURED: asking a small model to make this judgment produced two failure modes and no
 * successes. qwen-2.5-7b answered NEEDS_CLARIFICATION to everything including "write a
 * debounce" — vacuously safe and useless. ministral-3b turned the two words "give pdf"
 * into "PDF file with embedded metadata (author, title, creation date) extracted and
 * validated for integrity", inventing a subject out of nothing. That is the same
 * fabrication the artifact path already hit on bare "give pdf" requests.
 *
 * A rule cannot fabricate. If the draft is too thin to rewrite honestly, the user is
 * told so and their text is left alone; the model is never asked.
 *
 * MATCHED WORD BY WORD, so every entry here is a single word. An earlier version listed
 * "can you" and "i want" as phrases; a test caught that they could never match, because
 * the input is split on word boundaries before this is applied. Dead alternatives in a
 * guard are worse than missing ones -- they read as covered.
 */
const FILLER =
  /^(?:please|pls|plz|hey|hi|ok|okay|now|just|can|could|would|you|i|want|need|like|some|give|get|make|do|write|create|build|add|fix|the|a|an|me|it|this|that|us)$/i;

/** Format words that name a container but no subject: "give pdf", "zip please". */
const BARE_FORMAT = /^(?:pdf|pdfs|zip|zips|file|files|doc|docs|document|code|project|app)$/i;

/**
 * Is there anything here to be specific ABOUT?
 *
 * Counts the words that are neither filler nor a bare format noun. ONE such word is the
 * floor, and the live run is why: at two, "write a debounce" was refused — "write" and
 * "a" are filler, leaving one subject — even though it is obviously enhanceable and the
 * model rewrote it well. One substantive word IS a subject to be specific about.
 *
 * The sparse cases still fall through, because they have none at all: "give pdf" is a
 * filler verb and a container noun, "fix it" is two filler words, "pdf" is a container
 * on its own.
 */
export function hasEnhanceableSubject(text: string): boolean {
  const words = text
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/i)
    .filter((w) => w.length > 0);

  const substantive = words.filter((w) => !FILLER.test(w) && !BARE_FORMAT.test(w));
  return substantive.length >= 1;
}

/**
 * The user's draft is UNTRUSTED INPUT and is quoted, never interpolated as instruction.
 *
 * The containment is the output contract, as it is for the intent classifier: whatever
 * comes back is shown to the user as a SUGGESTION they must accept, and the worst a
 * crafted draft achieves is putting text in front of the person who wrote it. It cannot
 * send, cannot reach the chat pipeline, and cannot act.
 */
function buildPrompt(text: string): string {
  return `Rewrite a developer's request so it is clearer and more specific.

Rules:
- Keep the SAME subject. Never introduce a language, framework, library or filename the request does not mention.
- Add only detail already implied by the request: output shape, edge cases, constraints.
- One or two sentences. Still a request, not a specification.
- No preamble, no quotes, no explanation. Output only the rewritten request.

Request:
<<<
${text}
>>>`;
}

/** Strip the wrappers small models add despite being told not to. */
function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:rewrite|rewritten request|enhanced request|request)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/**
 * Rewrite a draft, or explain why it cannot be rewritten honestly.
 *
 * Never throws. Every failure returns the original text with status "failed".
 */
export async function enhancePrompt(rawText: string): Promise<EnhanceResult> {
  const original = typeof rawText === "string" ? rawText : "";
  const trimmed = original.trim();

  if (trimmed.length === 0) {
    return { status: "failed", text: original };
  }

  if (trimmed.length > ENHANCER_MAX_INPUT_CHARS) {
    logger.warn("Prompt enhancer skipped an over-long draft", {
      outcome: "skipped-too-long",
      chars: trimmed.length,
    });
    return { status: "failed", text: original };
  }

  if (!hasEnhanceableSubject(trimmed)) {
    logger.warn("Prompt enhancer found nothing to enhance", {
      outcome: "needs-clarification",
      chars: trimmed.length,
    });
    return {
      status: "needs-clarification",
      text: original,
      reason:
        "This is too short to expand without guessing what it is about. Add what you want it to do, and what it should apply to.",
    };
  }

  const started = Date.now();
  const timeoutMs = getIntentTimeoutMs();

  try {
    const resolved = resolveModel(process.env.CODEMIND_ENHANCER_MODEL || ENHANCER_MODEL_ID, {
      allowInternal: true,
    });

    const result = await generateText({
      model: resolved.model,
      prompt: buildPrompt(trimmed),
      maxTokens: ENHANCER_MAX_OUTPUT_TOKENS,
      temperature: 0,
      // NO RETRIES. A retry doubles the wait under a spinner the user is watching, and
      // the fallback costs them nothing: their own text, unchanged.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const text = clean(result.text);

    // An empty or unchanged answer is a failure, not an enhancement. Returning it as one
    // would make the button look broken in the most confusing way available: it appears
    // to work and changes nothing.
    if (text.length === 0 || text.toLowerCase() === trimmed.toLowerCase()) {
      logger.warn("Prompt enhancer returned nothing usable", {
        outcome: "failed",
        reason: text.length === 0 ? "empty" : "unchanged",
        elapsedMs: Date.now() - started,
      });
      return { status: "failed", text: original };
    }

    logger.info("Prompt enhanced", {
      outcome: "enhanced",
      model: resolved.descriptor.id,
      elapsedMs: Date.now() - started,
      originalChars: trimmed.length,
      enhancedChars: text.length,
    });
    return { status: "enhanced", text };
  } catch (error) {
    logger.warn("Prompt enhancement failed; the draft is unchanged", {
      outcome: "failed",
      elapsedMs: Date.now() - started,
      timeoutMs,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", text: original };
  }
}
