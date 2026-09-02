import type { EditIntent } from "@/lib/ai/intent";
import { estimateTokens } from "@/lib/ai/context-manager";
import { findTruncation } from "@/lib/artifacts/validate";

/**
 * Resolving and refusing a single-file repository edit.
 *
 * SEPARATE FROM THE ROUTE because a Next route module may only export HTTP handlers,
 * and because the refusal is the load-bearing behaviour of this feature — it has to be
 * testable without standing up a request, a database or a provider.
 *
 * Everything here is pure. The route owns the decision to call it and the Response it
 * builds from the result; this module owns only what the answer should be.
 */

/** Line separator, built from its char code so no source escape can be mangled. */
const NEWLINE = String.fromCharCode(10);

/** Why an edit could not be attempted, or the path it will be attempted on. */
export type EditResolution =
  | { kind: "ready"; path: string }
  | { kind: "no-files" }
  | { kind: "not-found"; named: string; available: string[] }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not-whole"; path: string }
  | { kind: "too-large"; path: string; chars: number; needed: number; budget: number };

/**
 * Resolve a loosely-named target to one fetched path.
 *
 * RESOLVED AGAINST WHAT WAS ACTUALLY FETCHED, not against the whole index. The index
 * would offer paths the model cannot see this turn, and "resolved to a file that is not
 * in context" is the exact shape of the failure this slice exists to prevent. Selection
 * has already ranked the repository against the user's own words, so the fetched set is
 * both small and relevant.
 *
 * AMBIGUITY IS NEVER RESOLVED BY GUESSING. Two plausible files means the user is asked
 * which one; picking the higher-ranked one silently would rewrite a file they did not
 * mean, and they would have no way to tell from the reply.
 */
export function resolveEditTarget(
  edit: EditIntent,
  fetched: Array<{ path: string; content: string }>,
  whole: string[],
  outputBudget: number
): EditResolution {
  const paths = fetched.map((f) => f.path);
  if (paths.length === 0) return { kind: "no-files" };

  let candidates: string[];

  if (edit.namedPath) {
    // Suffix match so "auth.ts" finds "src/routes/auth.ts", anchored on a segment
    // boundary so "auth.ts" cannot match "oauth.ts".
    const named = edit.namedPath.toLowerCase();
    candidates = paths.filter((p) => {
      const lower = p.toLowerCase();
      return lower === named || lower.endsWith(`/${named}`);
    });
    if (candidates.length === 0) {
      return { kind: "not-found", named: edit.namedPath, available: paths };
    }
  } else {
    // A described target with no filename. Only one fetched file means the selection
    // already agreed with the description; more than one is genuinely ambiguous.
    candidates = paths;
  }

  if (candidates.length > 1) return { kind: "ambiguous", candidates };

  const path = candidates[0];
  if (!whole.includes(path)) return { kind: "not-whole", path };

  /**
   * SIZE IS CHECKED LAST, and only once one file is settled on: it is the only refusal
   * that needs the file's contents, and asking "can the reply hold this?" about a file
   * we have not identified yet would be answering the wrong question.
   *
   * Ordered AFTER wholeness deliberately. A file that was clamped is one we only half
   * saw, and reporting its size as the reason would name a consequence instead of the
   * cause.
   */
  const content = fetched.find((f) => f.path === path)?.content ?? "";
  if (!fitsOutputBudget(content, outputBudget)) {
    return {
      kind: "too-large",
      path,
      chars: content.length,
      needed: editOutputTokens(content),
      budget: outputBudget,
    };
  }

  return { kind: "ready", path };
}

/**
 * The per-turn note for an edit whose file is present in full.
 *
 * Says only what the server has verified — that this exact path is in view complete —
 * and asks for the whole file back. The grounding and output-contract layers already
 * cover refusing on missing context and fencing code, so this adds neither.
 */
export function editNoteFor(path: string, content: string): string {
  const fence = fenceFor(content);
  return (
    `The user is asking for a change to ${path}. That file appears above IN FULL — ` +
    `every line of it, not an excerpt. Return the COMPLETE modified file in ONE fenced ` +
    `code block, not a fragment, not a diff, and not an ellipsis standing in for ` +
    `unchanged code. Say in one line what you changed and why before the block. If the ` +
    `change would require editing a file other than ${path}, say so instead of guessing.\n` +
    `Open and close that block with exactly ${fence.length} backticks (${fence}). This ` +
    `file contains Markdown fences of its own inside doc comments, and a shorter ` +
    `delimiter would be closed by one of them partway through the file.`
  );
}

/** The user-facing text for each refusal. Plain, and never hedged into a warning. */
export function editRefusalText(resolution: EditResolution): string {
  switch (resolution.kind) {
    case "no-files":
      return (
        "I could not read any files from the attached repository for this message, so " +
        "I will not attempt an edit. Editing a file I have not seen produces code that " +
        "looks right and is not. Try naming the file directly, or ask again."
      );
    case "not-found":
      return (
        `I did not fetch \`${resolution.named}\` for this message, so I will not edit ` +
        `it — I would be writing from memory rather than from the file. What I did ` +
        `read: ${resolution.available.map((p) => `\`${p}\``).join(", ")}. Name one of ` +
        `those, or rephrase so the file I need is the obvious match.`
      );
    case "ambiguous":
      return (
        "Several files could be the one you mean, and I will not guess which to " +
        `rewrite: ${resolution.candidates.map((p) => `\`${p}\``).join(", ")}. Which ` +
        "one should I change?"
      );
    case "too-large":
      return (
        `I will not attempt an edit to \`${resolution.path}\` because I cannot return ` +
        `it whole. That file is ${resolution.chars.toLocaleString("en-US")} characters, ` +
        `which needs roughly ${resolution.needed.toLocaleString("en-US")} output tokens, ` +
        `and this model's replies are capped at ${resolution.budget.toLocaleString("en-US")}. ` +
        `Editing it anyway would hand you a file that stops partway through with nothing ` +
        `marking where it ended. Ask for a change to one specific function instead, so the ` +
        `reply does not have to restate the whole file.`
      );
    case "not-whole":
      return (
        `\`${resolution.path}\` was too large to fit in this turn's context, so I only ` +
        `saw part of it and I will not edit it. A partial view produces a rewrite that ` +
        `silently drops whatever I could not see. Ask about a smaller file, or ask for ` +
        `a change to one specific function so the relevant part fits.`
      );
    case "ready":
      // Unreachable: callers branch on kind !== "ready" before reaching here.
      return "";
  }
}


/**
 * Output tokens a whole-file rewrite of `content` would cost.
 *
 * The model has to reproduce every line it was given, so the file's own size is the
 * floor on the reply. Uses the SAME estimator the context budget uses, because two
 * estimators disagreeing is how a precondition passes and the generation then fails.
 */
export function editOutputTokens(content: string): number {
  return estimateTokens(content);
}

/**
 * Can a whole-file rewrite of this file fit in the model's output budget?
 *
 * THE FAILURE THIS PREVENTS, measured on the live chat path. ky's source/core/Ky.ts is
 * 40,428 chars and needs ~11,551 output tokens; effectiveOutputTokens is 8,192. The
 * generation returned 966 of 1,211 lines, the fence never closed, and it stopped
 * mid-statement inside a catch block. Nothing told the user — the chat path never ran
 * a truncation check, so a file that silently lost 245 lines looked finished.
 *
 * The margin is context-manager's SAFETY_MARGIN_RATIO, imported rather than restated.
 * That constant exists because estimateTokens is a heuristic that errs optimistic on
 * dense code, which is exactly the direction that would let this precondition pass a
 * file the provider then truncates.
 */
/**
 * Tokens reserved for everything in the reply that is NOT the file.
 *
 * MEASURED, not guessed. Across the six whole-file edit replies captured while probing
 * this path — four complete, one truncated, one split by the fence defect — the prose
 * outside the code block cost:
 *
 *   ms fortnight unit          193 tokens
 *   ms unit-ladder refactor    217 tokens
 *   ms throw-on-unparseable    142 tokens
 *   ms premise corrected        60 tokens
 *   ky merge.ts                 45 tokens   (understated: the split reply's leaked
 *                                            prose falls inside the extracted span)
 *   ky Ky.ts                    90 tokens   (understated: reply was cut off early)
 *
 * Max on a complete reply: 217. The reserve is 512 — roughly 2.4x that — and the
 * headroom is deliberate, because the sample is small (n=6, one model, one file per
 * prompt) and every prompt asked for a terse change. A model that chooses to explain
 * its reasoning at length, or lists the edits it made before the block, spends more
 * than any of these did and nothing caps it.
 *
 * WHY NOT SAFETY_MARGIN_RATIO, which this function used before: that constant is 2% of
 * the CONTEXT window, sized for estimator drift when packing a prompt. At an 8,192
 * reply budget it yields 164 tokens — below the maximum prose overhead already
 * observed, and scaled to the wrong quantity entirely. A file estimated at 8,000
 * tokens passed that check and then truncated on the preamble, which is precisely the
 * failure the backstop was left to catch.
 */
export const EDIT_REPLY_OVERHEAD_TOKENS = 512;

/**
 * Tokens spent on the fence delimiters themselves.
 *
 * Small, but not zero, and it grows with the delimiter: a file carrying its own
 * Markdown fences needs a longer opener, and a language tag and two newlines ride
 * along with it. Counted rather than assumed so the arithmetic below is complete.
 */
export function fenceTokens(content: string): number {
  const fence = fenceFor(content);
  return estimateTokens(`${fence}typescript\n\n${fence}`);
}

export function fitsOutputBudget(content: string, outputBudget: number): boolean {
  const available = outputBudget - EDIT_REPLY_OVERHEAD_TOKENS - fenceTokens(content);
  return editOutputTokens(content) <= available;
}

/**
 * The fence delimiter that can safely wrap this content.
 *
 * THE FAILURE THIS PREVENTS, also measured. ky's source/utils/merge.ts carries a
 * Markdown fence inside a JSDoc @example (lines 35 and 47). Returned inside a three
 * backtick fence, the example's own fence CLOSED the block early: the reply came back
 * as two blocks with the example content leaking between them as prose. The file was
 * complete — 331 lines against 330 — and unusable, because taking "the code block"
 * gave either the first 35 lines or the last 297.
 *
 * CommonMark's rule: a fenced block ends at a run of the SAME character at least as
 * long as the opener, so an opener longer than any run inside the content cannot be
 * closed early. Counted by scanning rather than by regex, so no escaping subtlety sits
 * between this and the thing it protects.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of content) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // Three is the Markdown minimum; anything longer must clear the longest inner run.
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Truncation found in a whole-file edit the model already streamed.
 *
 * THE BACKSTOP, and it is required even with the precondition in front of it: the
 * estimator is a heuristic and will be wrong in both directions. Reuses
 * `findTruncation` from the artifact validator directly — it takes two strings and
 * returns a string, with no artifact types in its signature, so there is nothing to
 * extract and no second implementation to drift.
 */
export function findEditTruncation(path: string, content: string): string | null {
  return findTruncation(path, content);
}

/**
 * Extract the fenced code block from a reply, tolerating a delimiter of any length.
 *
 * Deliberately takes the FIRST opening fence to the LAST closing one: a reply split by
 * the merge.ts defect has content between blocks, and treating the whole span as the
 * file is what lets the truncation check see the real end of the output.
 */
export function extractFencedBlock(reply: string): string | null {
  const lines = reply.split(NEWLINE);
  let open = -1;
  let close = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      if (open === -1) open = i;
      else close = i;
    }
  }
  if (open === -1) return null;
  const end = close === -1 ? lines.length : close;
  return lines.slice(open + 1, end).join(NEWLINE);
}

/**
 * Machine-readable truncation marker, carried on the reply's annotations.
 *
 * WHY A FIELD AND NOT ONLY PROSE. The appended notice works for a person reading chat
 * and is invisible to anything else. A CLI, an apply step, or a later agent turn reads
 * the reply text, finds a fenced code block, and has no way to know the file inside it
 * stops mid-function — the prose is just more text above the block. Both consumers
 * exist, so both signals ship: the notice for the reader, this for the caller.
 *
 * Rides the SAME message_annotations channel codemindPlan and codemindArtifacts
 * already use, so nothing new is invented and a reload path that re-attaches
 * annotations carries it without further work.
 */
export interface EditTruncationSignal {
  path: string;
  reason: string;
  /** Always false. Present so a consumer can branch on the fact, not infer it. */
  usable: false;
}

/** The annotation payload, in the shape the stream and the client both expect. */
export function editTruncationAnnotation(path: string, reason: string): {
  codemindEditTruncated: EditTruncationSignal;
} {
  return { codemindEditTruncated: { path, reason, usable: false } };
}

/**
 * Read the marker back off a reply's annotations. THE ONE ACCESSOR — a consumer that
 * pulls a code block out of an edit reply calls this first, and treats a non-null
 * result as "do not use this content".
 */
export function readEditTruncation(annotations: unknown): EditTruncationSignal | null {
  if (!Array.isArray(annotations)) return null;
  for (const entry of annotations) {
    if (entry && typeof entry === "object" && "codemindEditTruncated" in entry) {
      const value = (entry as Record<string, unknown>).codemindEditTruncated;
      if (value && typeof value === "object") {
        const signal = value as Partial<EditTruncationSignal>;
        if (typeof signal.path === "string" && typeof signal.reason === "string") {
          return { path: signal.path, reason: signal.reason, usable: false };
        }
      }
    }
  }
  return null;
}

/**
 * Truncation signal for a finished edit reply, or null if it is complete.
 *
 * ONE IMPLEMENTATION, TWO CALLERS with different jobs: the stream guard annotates the
 * live response so the browser learns immediately, and onFinish stores it so a reload
 * still knows. Neither can do the other's work — the guard has no transaction and
 * onFinish cannot inject into a stream it has already finished — so the check is shared
 * rather than the call site.
 */
export function editTruncationFor(path: string, replyText: string): EditTruncationSignal | null {
  const block = extractFencedBlock(replyText);
  if (block === null) return null;
  const reason = findEditTruncation(path, block);
  return reason ? { path, reason, usable: false } : null;
}

/** What the user is told when a streamed edit turns out to be cut off. */
export function truncationNotice(path: string, reason: string): string {
  return (
    `

---

**This edit is incomplete and must not be applied.** The reply for ` +
    `\`${path}\` was cut off before the file ended: ${reason}. The model ran out of ` +
    `output budget partway through. Ask for a change to one specific function instead, ` +
    `so the reply does not have to restate the whole file.`
  );
}
