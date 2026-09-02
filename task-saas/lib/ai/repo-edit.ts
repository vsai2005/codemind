import type { EditIntent } from "@/lib/ai/intent";

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

/** Why an edit could not be attempted, or the path it will be attempted on. */
export type EditResolution =
  | { kind: "ready"; path: string }
  | { kind: "no-files" }
  | { kind: "not-found"; named: string; available: string[] }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not-whole"; path: string };

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
  fetched: Array<{ path: string }>,
  whole: string[]
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
  return { kind: "ready", path };
}

/**
 * The per-turn note for an edit whose file is present in full.
 *
 * Says only what the server has verified — that this exact path is in view complete —
 * and asks for the whole file back. The grounding and output-contract layers already
 * cover refusing on missing context and fencing code, so this adds neither.
 */
export function editNoteFor(path: string): string {
  return (
    `The user is asking for a change to ${path}. That file appears above IN FULL — ` +
    `every line of it, not an excerpt. Return the COMPLETE modified file in one fenced ` +
    `code block, not a fragment, not a diff, and not an ellipsis standing in for ` +
    `unchanged code. Say in one line what you changed and why before the block. If the ` +
    `change would require editing a file other than ${path}, say so instead of guessing.`
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
