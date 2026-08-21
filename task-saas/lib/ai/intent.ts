import type { ArtifactType } from "@/lib/artifacts/types";

/**
 * Deterministic artifact-intent detection.
 *
 * The model no longer decides whether to emit an artifact — the server does, before
 * any generation happens. That is what keeps source files out of the visible chat
 * stream: normal chat runs on a system prompt that has no artifact instructions at
 * all, so it physically cannot emit `<file path="...">` blocks.
 *
 * This is a heuristic over the user's own words. It is intentionally conservative:
 * when in doubt it returns null and the request is handled as normal chat, where the
 * model answers with ordinary Markdown code blocks. Asking explicitly ("give me the
 * project as a zip") always wins.
 */

/** Phrases that mean "hand me a deliverable", as opposed to "explain/write it out". */
const DELIVERY =
  /\b(give me|send me|hand me|provide me|get me|download|downloadable|export|package (?:it|this|them|the)|bundle|zip (?:it|this|them|up)|as an? (?:file|download|zip|pdf|attachment)|i want the files?)\b/;

/** Phrases that mean "render it in the conversation". Suppresses artifact generation. */
const SHOW_INLINE =
  /\b(show me|show the|show us|display|print|paste|walk me through|teach me|example of|how (?:do|would) i|how does|what(?:'s| is)|explain how)\b/;

const PROJECT_NOUN =
  /\b(project|codebase|repo|repository|monorepo|scaffold|boilerplate|starter(?: kit| template)?|whole app|entire app|full app)\b/;

const ZIP_NOUN = /\bzips?\b|\.zip\b/;
const PDF_NOUN = /\bpdfs?\b|\.pdf\b/;
const AS_PDF = /\b(?:as|into|to)\s+an?\s+pdf\b/;
const PDF_PRODUCE_VERB = /\b(export|generate|create|make|write|turn|produce|render|convert)\b/;

const SCRIPT_NOUN = /\b(scripts?|files?|components?|modules?)\b/;

const FILENAME_REF =
  /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|css|scss|html|json|ya?ml|toml|ini|sh|bash|sql|md|txt|prisma)\b/i;

/** Plural "files" implies more than one file, which needs packaging. */
const MULTI_FILE = /\b(?:the |all (?:the )?|these |those )?files\b/;

export interface ArtifactIntent {
  type: ArtifactType;
  /** Why this was classified as an artifact request. Useful for logs and tests. */
  reason: string;
}

/**
 * Classify a user message. Returns null for normal chat.
 */
export function detectArtifactIntent(rawText: unknown): ArtifactIntent | null {
  if (typeof rawText !== "string") return null;

  const text = rawText.toLowerCase();
  if (text.trim().length === 0) return null;

  const wantsDelivery = DELIVERY.test(text);
  const wantsInline = SHOW_INLINE.test(text);

  // "Show me middleware.ts" / "Show me a React component" stay in the conversation.
  // An explicit delivery phrase overrides ("show me the zip and give me the file").
  if (wantsInline && !wantsDelivery) return null;

  // --- ZIP -----------------------------------------------------------------
  if (ZIP_NOUN.test(text) && (wantsDelivery || PROJECT_NOUN.test(text))) {
    return { type: "zip", reason: "explicit zip request" };
  }
  if (wantsDelivery && PROJECT_NOUN.test(text)) {
    return { type: "zip", reason: "delivery of a whole project" };
  }
  if (wantsDelivery && MULTI_FILE.test(text)) {
    return { type: "zip", reason: "delivery of multiple files" };
  }

  // --- PDF -----------------------------------------------------------------
  if (PDF_NOUN.test(text) && (wantsDelivery || AS_PDF.test(text) || PDF_PRODUCE_VERB.test(text))) {
    return { type: "pdf", reason: "explicit pdf request" };
  }

  // --- SINGLE FILE ---------------------------------------------------------
  if (wantsDelivery && (FILENAME_REF.test(text) || SCRIPT_NOUN.test(text))) {
    return { type: "file", reason: "delivery of a single file" };
  }

  return null;
}
