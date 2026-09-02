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

/**
 * Repair the handful of typos that silently downgrade a delivery request to plain chat.
 *
 * This exists because of a real failure: "giev me inthe pdf the code" produced no
 * artifact intent, so the request fell through to normal chat. Two separate slips did
 * it — a transposed "give" and a missing space in "in the" — and neither is unusual in
 * a chat box. A missed match here is invisible to the user: they asked for a PDF and
 * simply did not get one.
 *
 * Deliberately a short, closed list rather than fuzzy matching. Each entry is a
 * specific slip with no legitimate alternative reading, so nothing here can turn a
 * message that was not a delivery request into one. General fuzzy matching would.
 *
 * Applied before every pattern below, so ZIP and single-file detection benefit too.
 */
function normalizeForIntent(text: string): string {
  return (
    text
      .toLowerCase()
      // "give" transposed or clipped
      .replace(/\bgiev\b/g, "give")
      .replace(/\bgve\b/g, "give")
      .replace(/\bgiv\b/g, "give")
      .replace(/\bgimme\b/g, "give me")
      // prepositions run into the following article
      .replace(/\binthe\b/g, "in the")
      .replace(/\bina\b/g, "in a")
      .replace(/\basa\b/g, "as a")
      .replace(/\bintoa\b/g, "into a")
  );
}

/**
 * Phrases that mean "hand me a deliverable", as opposed to "explain/write it out".
 *
 * The object matters as much as the verb: "give me", "give it to me" and "make me" are
 * all requests, and only listing "give me" missed most of them. "i want" / "i need"
 * are included because they are how people actually ask.
 */
const DELIVERY =
  /\b((?:give|send|hand|provide|get|make)\s+(?:me|us|it|this|that|them)\b|(?:give|send|hand)\s+it\s+to\s+(?:me|us)\b|i\s+(?:want|need|would like)\b|download|downloadable|export|package (?:it|this|them|the)|bundle|zip (?:it|this|them|up)|as an? (?:file|download|zip|pdf|attachment)|i want the files?)\b/;

/** Phrases that mean "render it in the conversation". Suppresses artifact generation. */
const SHOW_INLINE =
  /\b(show me|show the|show us|display|print|paste|walk me through|teach me|example of|how (?:do|would) i|how does|what(?:'s| is)|explain how)\b/;

const PROJECT_NOUN =
  /\b(project|codebase|repo|repository|monorepo|scaffold|boilerplate|starter(?: kit| template)?|whole app|entire app|full app)\b/;

const ZIP_NOUN = /\bzips?\b|\.zip\b/;
const PDF_NOUN = /\bpdfs?\b|\.pdf\b/;
/** The article is optional — "as pdf" is written as often as "as a pdf". */
const AS_PDF = /\b(?:as|into|to)\s+(?:an?\s+|the\s+)?pdf\b/;

/**
 * "give me in the pdf", "put the code in a pdf", "inside the pdf".
 *
 * Natural phrasing that AS_PDF does not cover: people say "in the PDF" at least as
 * often as "as a PDF", and the request is equally explicit.
 *
 * The negative lookahead keeps descriptive sentences out. "how text is stored in pdf
 * files" is about PDFs, not a request for one; "put it in pdf" is a request.
 */
const IN_PDF =
  /\b(?:in|inside|within)\s+(?:an?\s+|the\s+)?pdf\b(?!\s+(?:files?|documents?|readers?|viewers?|format\s+the))/;

/** "in pdf format", "pdf format please" — a format request, not a passing mention. */
const PDF_FORMAT = /\bpdf\s+format\b/;
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

  const text = normalizeForIntent(rawText);
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
  // The noun alone is never enough — "what does pdf stand for" is not a request for
  // one. It must be paired with evidence the user wants to RECEIVE a PDF.
  if (
    PDF_NOUN.test(text) &&
    (wantsDelivery ||
      AS_PDF.test(text) ||
      IN_PDF.test(text) ||
      PDF_FORMAT.test(text) ||
      PDF_PRODUCE_VERB.test(text))
  ) {
    return { type: "pdf", reason: "explicit pdf request" };
  }

  // --- SINGLE FILE ---------------------------------------------------------
  if (wantsDelivery && (FILENAME_REF.test(text) || SCRIPT_NOUN.test(text))) {
    return { type: "file", reason: "delivery of a single file" };
  }

  return null;
}

/**
 * Verbs that mean "change code that already exists", as opposed to "write me new code".
 *
 * The distinction is the whole classifier. "write a debounce function" is generation
 * and belongs to the artifact pipeline; "fix the debounce in utils.ts" is an edit
 * against a file that is already there. Only the second needs the file in front of the
 * model, and only the second can be silently wrong by editing something it half-saw.
 */
const EDIT_VERB =
  /\b(fix|correct|repair|change|modify|update|edit|patch|refactor|rename|rewrite|adjust|tweak|improve|optimi[sz]e|simplify|clean up|handle|guard|harden)\b|\b(add|remove|delete|drop|replace|extract|inline|move)\b(?=[^.?!]*\b(?:to|from|in|into|within|inside|out of)\b)/;

/**
 * Evidence that the verb has a target IN THE REPOSITORY rather than in the abstract.
 *
 * A filename is the strong form. The weak form is a definite noun phrase — "the retry
 * logic", "the auth middleware" — which is how people actually name a file they cannot
 * remember the path of. Resolution of that phrase happens in the route against files
 * actually fetched; this only decides that an edit was asked for.
 */
const EDIT_TARGET_PHRASE =
  /\bthe\s+[\w-]+(?:\s+[\w-]+)?\s+(?:logic|function|handler|helper|method|class|module|component|middleware|route|hook|util(?:ity)?|parser|validator|check|guard|config)\b/;

export interface EditIntent {
  /** The filename the user named, when they named one. Null for a phrase-only target. */
  namedPath: string | null;
  /** Why this was classified as an edit. For logs and tests. */
  reason: string;
}

/**
 * Classify a message as a request to CHANGE an existing repository file.
 *
 * WHERE THIS SITS RELATIVE TO THE ARTIFACT ROUTER, and it is not a third branch of it:
 * `detectArtifactIntent` decides "should the artifact pipeline answer instead of the
 * chat model?", and a non-null answer means the chat model never runs. An edit is a
 * CHAT answer — a fenced code block in the reply — so this is only ever consulted when
 * that router has already declined. The route enforces that ordering; this function
 * does not know about it.
 *
 * That ordering is also the disambiguation rule for "download the fixed auth.ts".
 * DELIVERY plus a filename is already `{ type: "file" }`, so it goes to the artifact
 * pipeline exactly as it does today and never reaches here. Slice one DELIBERATELY
 * DOES NOT HANDLE the "edit it and hand me the file" case: producing a downloadable
 * edit needs an artifact type, a schema migration and a download path, all of which
 * are out of scope. The existing behaviour for those messages is unchanged rather
 * than half-changed.
 *
 * Conservative in the same way as the artifact router: when in doubt it returns null
 * and the turn is ordinary chat, which is what it was before this existed.
 */
export function detectEditIntent(rawText: unknown): EditIntent | null {
  if (typeof rawText !== "string") return null;

  const text = normalizeForIntent(rawText);
  if (text.trim().length === 0) return null;

  if (!EDIT_VERB.test(text)) return null;

  const named = FILENAME_REF.exec(text);
  if (named) return { namedPath: named[0], reason: "edit verb with a named file" };

  if (EDIT_TARGET_PHRASE.test(text)) {
    return { namedPath: null, reason: "edit verb with a described target" };
  }

  // A verb with nothing to aim at. "fix it" after an explanation is a real request,
  // but resolving "it" needs conversation state this classifier does not see, and
  // guessing a file to rewrite is the one failure this slice exists to prevent.
  return null;
}

/**
 * Does this message mention files or downloads AT ALL — deliberately loose.
 *
 * WHY THIS IS NOT `detectArtifactIntent`
 *
 * These two answer opposite questions and must not be confused. `detectArtifactIntent`
 * asks "should the artifact pipeline handle this instead of the chat model?", and a
 * non-null answer means the chat model is never called. So on the chat path it is
 * ALWAYS null — gating anything about chat on it would gate on a constant.
 *
 * This asks the question that actually matters for the chat prompt: "might this user
 * be thinking about a file, even though the router declined to build one?" That is
 * precisely the population the download guardrails exist for. The documented incidents
 * all came from messages that landed HERE, not in the pipeline:
 *
 *   - "make me a pdf" scored as chat, and the model invented a tool call
 *   - an image attachment forces `intent = null` in the route regardless of wording,
 *     so "turn this into a PDF" with a screenshot attached reaches the chat model
 *
 * DELIBERATELY OVER-INCLUSIVE. The costs are asymmetric: a false positive spends ~194
 * tokens on guardrails that were not needed, while a false negative removes the only
 * thing standing between the user and a failure mode that has already regressed twice.
 * When in doubt this returns true, and callers should treat `false` as the exceptional
 * case rather than the default.
 */
export function mentionsFileDelivery(rawText: unknown): boolean {
  if (typeof rawText !== "string") return true; // unreadable input: assume it might
  const text = normalizeForIntent(rawText);
  if (text.trim().length === 0) return false; // genuinely nothing to be about

  return (
    DELIVERY.test(text) ||
    ZIP_NOUN.test(text) ||
    PDF_NOUN.test(text) ||
    PROJECT_NOUN.test(text) ||
    MULTI_FILE.test(text) ||
    SCRIPT_NOUN.test(text) ||
    FILENAME_REF.test(text)
  );
}
