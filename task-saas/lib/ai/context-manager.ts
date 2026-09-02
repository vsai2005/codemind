import { Message } from "ai";
import { ATTACHMENT_TAG_RE } from "@/lib/attachments";
import { getContextTokenLimit, getOutputTokenLimit } from "@/lib/env";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { mentionsFileDelivery } from "@/lib/ai/intent";
import { logger } from "@/lib/logger";

/**
 * Context Management V3
 *
 * Three complementary memory layers feed one shared budget:
 *
 *   recent turns          immediate conversational context (coherent USER→ASSISTANT)
 *   historical retrieval  exact evidence pulled from older turns, on demand
 *   rolling summary       long-term compressed memory of everything dropped
 *
 * None replaces another. PostgreSQL remains the source of truth; nothing here
 * deletes history, it only chooses what the model sees this turn.
 */

/**
 * CEILING for the static persona layers — an assertion, NOT what the budget subtracts.
 *
 * It was the subtraction until the prompt's layers became conditional, at which point
 * a fixed figure stopped being defensible in either direction. Sized to the typical
 * turn it would under-reserve the worst one; sized to the worst turn (494) it charged
 * every plain question 291 tokens it never spent, which made the common case worse
 * than the flat 400 that came before conditional assembly. `buildContext` now measures
 * the layers it actually selected and subtracts that.
 *
 * What this still does is bound the measurement. Nothing enforces that a future layer
 * edit keeps the prompt small, and a prompt that quietly grew would now quietly shrink
 * the conversation window instead of tripping a fixed reserve. Exceeding this is a bug
 * — buildSystemPrompt warns, and the per-layer ceilings in STATIC_PROMPT_TOKEN_BUDGET
 * name which layer grew. Keep the two numbers in step.
 *
 * Lowered 520 -> 415 on 2026-09-03 with STATIC_PROMPT_TOKEN_BUDGET, because the
 * estimator calibration left both measuring a fifth less than when they were sized.
 * See that constant for the four re-measured scenarios.
 */
export const SYSTEM_PROMPT_RESERVE = 415;

/**
 * Held back so an estimator miss cannot push the request past the provider ceiling.
 * The estimator is a heuristic (see estimateTokens) and errs optimistic on dense code.
 */
const SAFETY_MARGIN_RATIO = 0.02;

/**
 * Images consume provider-side tokens that a text estimator cannot see, so a
 * multimodal request reserves extra headroom rather than pretending the image is free.
 */
const IMAGE_HEADROOM_TOKENS = 4000;

/** Caps keep any single memory layer from starving the others. */
/** Workspace context is small by nature; these caps stop a pathological paste. */
const PROJECT_INSTRUCTIONS_RATIO = 0.05;
const PROJECT_MEMORY_RATIO = 0.05;

const SUMMARY_BUDGET_RATIO = 0.1;
const CONVERSATION_RETRIEVAL_RATIO = 0.15;
const ATTACHMENT_RETRIEVAL_RATIO = 0.15;

/**
 * Share of the window for source files fetched from an indexed repository.
 *
 * The largest single allowance here, because a repo-backed question is usually ABOUT
 * the code: a file the model cannot see is a file it will guess about. Still a
 * fraction rather than the whole budget — the conversation, the summary and the user's
 * own message all still have to fit, and a repo question that loses its own history is
 * no better than one that loses the code.
 */
const REPOSITORY_FILE_RATIO = 0.35;

const MAX_RETRIEVED_TURNS = 3;
const RETRIEVED_MESSAGE_MAX_CHARS = 1200;
const MAX_ATTACHMENT_CHUNKS = 5;
const ATTACHMENT_CHUNK_SIZE = 1500;

/**
 * Token limits come from the validated runtime configuration in lib/env.ts, which is
 * the only place the environment is read and the only place a default is defined.
 * Re-exported here so existing importers keep their import path.
 */
export { getContextTokenLimit, getOutputTokenLimit };

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Characters per token, by content type. THE CANONICAL RATIOS — every token-cost
 * decision in the codebase resolves to a number in this object.
 *
 * They lived in two places until 2026-09-02 and had already drifted: selection.ts
 * carried its own 3.0 while this module carried 3.2, describing the same physical
 * quantity for the same model. Worse, selection's number was not chosen at all — it
 * fell out of the encoded-content clamp below firing on a synthetic placeholder. A
 * calibration that touched one and not the other would have moved file ranking
 * silently, which is exactly what happened.
 *
 * Calibrated against the provider on 2026-09-02; see estimateTokens for the samples
 * and the measured ratios each of these sits below.
 */
export const CHARS_PER_TOKEN = {
  /** Minified JSON, lockfiles, dense symbol soup. Measured 2.55. */
  dense: 2.5,
  /** Typical TS/TSX/JSON and markdown. Measured 3.25 to 3.95. */
  source: 3.2,
  /** Code carrying prose comments. UNMEASURED — no sample landed in this band. */
  commented: 3.5,
  /** Prose. Measured 5.56. */
  prose: 5.0,
  /** Base64 and hashes, which tokenize far worse than their punctuation suggests. */
  encoded: 3.0,
} as const;

/**
 * An unbroken alphanumeric run this long means encoded content, not source.
 *
 * NAMED because it was an unexplained literal that turned out to be load-bearing for
 * file pricing. Audited 2026-09-02 across every indexed file in both repositories:
 *
 *   real indexed source files triggering it        0 of 62
 *   ky package.json / readme / license / tsconfig  longest run 26
 *   longest realistic camelCase identifier         50
 *   base64 blob                                    184  <- fires, correctly
 *   sha256 hash                                     64  <- fires, correctly
 *
 * So it discriminates cleanly today, with the nearest ordinary-source shape at 50.
 * Note that it does NOT catch minified bundles despite an earlier comment saying so:
 * minified JS keeps punctuation between tokens and scores a longest run of 8. The
 * clamp catches ENCODED content, not compressed content.
 */
export const ENCODED_RUN_THRESHOLD = 60;

/**
 * How much more pessimistically a file is priced when only its SIZE is known.
 *
 * Selection ranks candidates from stored rows without fetching them, so it has a byte
 * count and no content — none of the signals the bucket logic reads. It therefore
 * charges more per byte than content pricing would: 3.2 x 0.9375 = 3.0 chars/token
 * exactly, which is also below the 3.25 minimum measured for real TypeScript.
 *
 * THE DIRECTION IS DELIBERATE. Under-charging gets a file fetched and then dropped by
 * the context packer, spending a GitHub request for nothing. Over-charging only leaves
 * a little headroom unused.
 *
 * Derived from CHARS_PER_TOKEN.source rather than written as its own literal, so a
 * future calibration of the source ratio moves byte pricing with it by construction —
 * which is the whole reason these numbers now live together.
 *
 * THIS FACTOR IS NOT A MEASURED ERROR RATE, and must not be cited as one. 0.9375 was
 * chosen because 3.2 x 0.9375 is exactly 3.0, which is the number byte pricing already
 * used — so consolidating the constants could not move file ranking. It is a
 * behaviour-preservation constant wearing the shape of a calibration.
 *
 * What IS evidence-backed is the direction and the rough size: 3.0 sits below the 3.25
 * minimum measured for real TypeScript, so byte pricing stays pessimistic. If the
 * source ratio is ever recalibrated, this factor deserves to be re-derived from
 * measurement rather than carried forward.
 */
export const SIZE_ONLY_PESSIMISM = 0.9375;

/**
 * Token cost of a file known only by its byte size. Bytes map 1:1 to characters for
 * source. Never zero: a file that costs nothing would always "fit", so an empty or
 * unreadable row would be selected ahead of real candidates.
 */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(Math.max(1, bytes) / (CHARS_PER_TOKEN.source * SIZE_ONLY_PESSIMISM));
}

/**
 * Content-aware token estimate. Still an estimate — there is no Nemotron tokenizer
 * in this codebase and this function must never be presented as exact.
 *
 * CALIBRATED 2026-09-02 AGAINST THE PROVIDER, replacing an assumption that was
 * measurably backwards. The previous comment here claimed a flat divisor was
 * "*optimistic* for code, which is the dangerous direction". Measured, it is the
 * opposite: every divisor was too LOW, so the estimator over-counted and the code
 * leaned pessimistic everywhere except JSON.
 *
 * Method: each sample sent as a prompt with maxTokens 1, reading usage.promptTokens,
 * minus a measured 17-token per-request baseline.
 *
 *   content                      chars   actual tok   real c/t   old divisor
 *   ms/src/index.ts               5,864        1,804       3.25          3.0
 *   ky/source/utils/merge.ts     10,470        2,716       3.85          3.0
 *   ky/source/utils/normalize.ts  3,211          832       3.86          3.0
 *   ky/package.json               2,317          907       2.55          2.5
 *   ky/readme.md                 63,697       16,140       3.95          3.0
 *   English prose (synthetic)     2,436          438       5.56          4.0
 *
 * PER-TYPE RATIOS ARE KEPT rather than collapsing to one constant. The punctuation
 * density branch already discriminates content types correctly — JSON landed on 2.5 and
 * measured 2.55, which is the branch working, not luck. A single constant fitted to code
 * would under-count prose by 39%, and one fitted to prose would over-count JSON by more
 * than double. The structure was right; only the numbers were wrong.
 *
 * THE SAFETY BIAS IS DELIBERATE AND ASYMMETRIC. Each divisor is set at or BELOW the
 * MINIMUM real ratio observed for its bucket, never at the mean, because the two
 * directions of error do not cost the same: over-counting wastes headroom that is
 * currently abundant, while under-counting overflows the window and fails the request
 * outright. So typical code takes 3.2 against a measured minimum of 3.25, and prose
 * takes 5.0 against 5.56.
 *
 * The 0.06–0.12 bucket is UNMEASURED and therefore unchanged at 3.5. No sample landed
 * in it, and moving a number with no evidence behind it is how the original values got
 * here.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const length = text.length;

  // Sample the ends of very large inputs; scanning megabytes per message is wasteful
  // and the head and tail are representative of the whole.
  const sample =
    length > 20000 ? `${text.slice(0, 10000)}${text.slice(length - 10000)}` : text;

  let punctuation = 0;
  let longestRun = 0;
  let currentRun = 0;

  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;

    if (isAlphaNumeric) {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
      if (!isSpace) punctuation++;
    }
  }

  const punctuationRatio = sample.length > 0 ? punctuation / sample.length : 0;

  let divisor: number;
  if (punctuationRatio > 0.2) {
    divisor = CHARS_PER_TOKEN.dense;
  } else if (punctuationRatio > 0.12) {
    divisor = CHARS_PER_TOKEN.source;
  } else if (punctuationRatio > 0.06) {
    divisor = CHARS_PER_TOKEN.commented;
  } else {
    divisor = CHARS_PER_TOKEN.prose;
  }

  // Encoded content — base64, hashes — tokenizes far worse than its punctuation
  // density suggests. See ENCODED_RUN_THRESHOLD for what does and does not trip this.
  if (longestRun > ENCODED_RUN_THRESHOLD && divisor > CHARS_PER_TOKEN.encoded) {
    divisor = CHARS_PER_TOKEN.encoded;
  }

  return Math.ceil(length / divisor);
}

/** Trim text so its estimate fits `maxTokens`, marking where it was cut. */
function clampToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;

  const ratio = maxTokens / tokens;
  const cut = Math.max(0, Math.floor(text.length * ratio) - 32);
  return `${text.slice(0, cut).trimEnd()}\n…[truncated]`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** A bare identifier: no path separators, dots or spaces to confuse a compound with. */
const IDENTIFIER_ONLY = /^[A-Za-z0-9_$]+$/;

/**
 * Split one word into the tokens it should match on, breaking camelCase and separators.
 *
 * THE SINGLE TOKENIZER FOR BOTH SIDES OF REPOSITORY SCORING. `pathWords` in
 * lib/repo/selection.ts calls this, and so does `queryTerms` below, because the two
 * sides drifting apart is not a hypothetical: the index split camelCase and the query
 * did not, so `validateConcurrency` was indexed as `validate` + `concurrency` while the
 * question tokenized to the single token `validateconcurrency`. It matched nothing.
 * A question naming an indexed symbol by its exact name scored ZERO, and only returned
 * a correct answer when `fallbackFiles` happened to pick the right file anyway.
 *
 * THE COMPOUND IS KEPT TOO, ahead of the parts. Splitting alone fixes the miss but
 * makes `validateConcurrency` score identically to a file declaring `validateInput`
 * and `concurrencyLimit` — both match `validate` and `concurrency`. Keeping the whole
 * name as a token gives the file that actually declares it one more hit, so an exact
 * name outranks a coincidental pair.
 *
 * Only for real identifiers. "src/lib" and "index.js" would otherwise contribute
 * "srclib" and "indexjs", which name nothing and no question would ever contain.
 */
export function identifierWords(segment: string): string[] {
  const parts = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

  if (parts.length > 1 && IDENTIFIER_ONLY.test(segment)) {
    const compound = segment.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (compound.length > 0 && !parts.includes(compound)) return [compound, ...parts];
  }

  return parts;
}

/**
 * Split a question into the terms worth matching on.
 *
 * Exported because repository file selection asks the same question of a user's
 * message that retrieval does. `scoreText` below is deliberately NOT exported: it
 * scores prose, and paths need different weighting — see lib/repo/selection.ts for
 * why forcing that one to be shared would have been the wrong kind of reuse.
 *
 * Splits on identifier boundaries BEFORE lowercasing, because lowercasing first
 * destroys the camelCase boundary this has to see.
 */
export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/[^A-Za-z0-9_$]+/)
        .flatMap((word) => identifierWords(word))
        .filter((t) => t.length > 2)
    )
  );
}

/** Term-frequency overlap. Deliberately deterministic — no embeddings, no vector store. */
function scoreText(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let index = -1;
    while ((index = lower.indexOf(term, index + 1)) >= 0) {
      score++;
    }
  }
  return score;
}

/**
 * Phrases that mark a turn as carrying a durable decision rather than small talk.
 * Used to bias historical retrieval toward the content people actually ask back about.
 */
const DECISION_SIGNALS =
  /\b(because|decided|decision|we'll use|we will use|going with|chose|chosen|instead of|rather than|trade-?off|requirement|must|should|constraint|architecture|schema|migration|convention|standard|prefer|approach|design|structure|root cause|resolved|fixed|error|bug|limitation|rule|policy|never|always)\b/i;

function decisionBoost(text: string): number {
  const matches = text.match(new RegExp(DECISION_SIGNALS.source, "gi"));
  return matches ? Math.min(matches.length, 8) * 2 : 0;
}

function chunkText(text: string, chunkSize: number = ATTACHMENT_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export interface RetrievalMessage {
  id: string;
  role: string;
  content: string;
}

interface Turn {
  messages: Message[];
  tokens: number;
}

/**
 * Group a flat message list into coherent turns. A turn starts at each user message
 * and absorbs the assistant replies that follow it, so history is added or removed as
 * whole question/answer units rather than orphaned halves.
 */
function groupIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: Message[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(toTurn(current));
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(toTurn(current));

  return turns;
}

function toTurn(messages: Message[]): Turn {
  const tokens = messages.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
    0
  );
  return { messages, tokens };
}

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

export type ContextPressureLevel = "normal" | "elevated" | "high" | "critical";

export interface ContextPressure {
  used: number;
  total: number;
  ratio: number;
  level: ContextPressureLevel;
}

function pressureLevel(ratio: number): ContextPressureLevel {
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.85) return "high";
  if (ratio >= 0.7) return "elevated";
  return "normal";
}

/** How many recent turns each pressure level permits. */
function turnAllowanceFor(level: ContextPressureLevel): number {
  switch (level) {
    case "critical":
      return 1; // lean on summary + retrieval instead
    case "high":
      return 3;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the current request alone cannot be made to fit. */
export class ContextOverflowError extends Error {
  constructor(
    message: string,
    readonly requiredTokens: number,
    readonly availableTokens: number
  ) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildContextOptions {
  /**
   * Context ceiling for the selected model, from the model registry's three-way
   * minimum (CodeMind target / provider window / runtime budget). Omitted falls back
   * to the environment budget, which keeps single-model callers working unchanged.
   */
  contextTokens?: number;
  /** Output reservation for the selected model. Omitted falls back to the env budget. */
  outputTokens?: number;
  /**
   * Standing instructions for the project this conversation belongs to. Budgeted
   * before history because they are the user's own rules for the workspace: losing
   * them to a long conversation would silently change how CodeMind behaves.
   */
  projectInstructions?: string | null;
  /** Durable project knowledge, rendered as titled sections. */
  projectMemory?: Array<{ title: string; items: string[] }> | null;
  /** Reserves extra headroom for provider-side image tokens the estimator cannot see. */
  hasImage?: boolean;
  /**
   * Older messages for historical retrieval, loaded server-side and already scoped to
   * the authenticated user's conversation. Never sourced from the request body.
   */
  retrievalCandidates?: RetrievalMessage[];
  /** Hard cap on recent turns. Used by the one-shot provider-error retry. */
  maxRecentTurns?: number;
  /**
   * Source files fetched from an indexed repository for this turn, already selected
   * and budgeted by lib/repo/selection.ts.
   *
   * Passed in rather than fetched here: this module must stay synchronous and free of
   * network calls, and selection needs the repository index that only the route has
   * loaded. What happens here is what happens to every other memory layer — it is
   * charged against the same budget, clamped by the same helper, and dropped when
   * there is no room.
   */
  repositoryFiles?: Array<{ path: string; content: string }>;
  /**
   * Stated when the repository could not be read for this turn.
   *
   * Rendered even though `repositoryFiles` is empty, which is the whole point: an
   * absent block and a failed read look identical to a model, and it will answer
   * confidently in both cases. This is the same honesty rule the index applies to
   * unsupported languages — report the gap rather than let silence imply coverage.
   */
  repositoryNote?: string;
}

export interface BuildContextResult {
  messages: Message[];
  droppedMessageIds: string[];
  droppedMessagesContent: string;
  systemPrompt: string;
  /**
   * Conversation memory and retrieved context, without the base persona.
   * Reused by the artifact pipeline so generation sees the same working context.
   */
  contextBlocks: string;
  /**
   * Repository files that reached the model WHOLE, by path.
   *
   * NOTHING DISTINGUISHED A CLAMPED FILE FROM A COMPLETE ONE BEFORE THIS. The loop
   * below may render a file in full, clamp the first one when nothing else has fit, or
   * break and omit the rest entirely — and all three produced the same `contextBlocks`
   * string with no way for a caller to tell which had happened. For an explanation
   * that is a quality issue; for an EDIT it is a correctness one, because a model handed
   * half a file rewrites it confidently and returns something plausible, wrong and
   * silently incomplete.
   *
   * A path appears here only if its ENTIRE content was rendered. Clamped and omitted
   * files are absent, and absence is the signal callers act on.
   */
  repositoryFilesWhole: string[];
  pressure: ContextPressure;
  retrievedMessageIds: string[];
}

/** Narrow an unknown JSON value to something with string-keyed properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The minimum shape `buildContext` needs from a stored message.
 *
 * Structural rather than Prisma's generated row type: the artifact pipeline and the
 * tests pass plain objects, and this function only ever reads these three fields.
 */
export interface HistoricalMessage {
  id?: string;
  role: string;
  content: unknown;
}

export class ContextManager {
  static buildContext(
    historicalMessages: HistoricalMessage[],
    newUserMessage: Message,
    existingSummary: string | null,
    options: BuildContextOptions = {}
  ): BuildContextResult {
    // Model-aware when the caller resolved a model; environment-driven otherwise.
    // Never larger than the environment budget: a model with a bigger window must not
    // be able to widen a limit the operator deliberately set.
    const maxOutput = Math.min(options.outputTokens ?? getOutputTokenLimit(), getOutputTokenLimit());
    const maxContext = Math.min(
      options.contextTokens ?? getContextTokenLimit(),
      getContextTokenLimit()
    );

    const safetyMargin = Math.ceil(maxContext * SAFETY_MARGIN_RATIO);
    const imageHeadroom = options.hasImage ? IMAGE_HEADROOM_TOKENS : 0;

    /**
     * The query string is needed HERE, before any budgeting, because the size of the
     * system prompt depends on it. It reads only `newUserMessage`, so hoisting it
     * above the attachment pass below changes nothing about what it produces.
     */
    const queryStr =
      typeof newUserMessage.content === "string"
        ? newUserMessage.content
        : JSON.stringify(newUserMessage.content);

    /**
     * Charge the prompt this turn ACTUALLY assembles, not a fixed worst case.
     *
     * Two of the prompt's layers are conditional, so its cost ranges from 203 tokens
     * for a plain question to 494 for a repo-backed request that also mentions a file.
     * Subtracting the 494 ceiling from every turn would hand the conditional layers'
     * saving to nobody: the plain question would build a 203-token prompt and still
     * reserve 494, leaving the common case worse off than the flat 400 that preceded
     * conditional assembly. Measuring instead returns the difference to the
     * conversation.
     *
     * REPOSITORY GROUNDING IS RESERVED OPTIMISTICALLY. Whether that layer is included
     * at assembly depends on whether any repository file survived budgeting, which is
     * not knowable until after this budget exists. So the reserve uses the input list
     * — an upper bound — while assembly uses the rendered block. The two agree except
     * when files were supplied and every one was priced out, where this over-reserves
     * by the grounding layer. That is the safe direction: a slightly smaller
     * conversation budget, never a prompt larger than the window allowed for.
     */
    const includeArtifactRules = mentionsFileDelivery(queryStr);
    const mayHaveRepositoryContext = (options.repositoryFiles?.length ?? 0) > 0;

    // buildSystemPrompt with no contextBlocks IS the static prompt — the same function
    // that assembles the real one, so the measurement cannot drift from what is sent.
    const staticPromptTokens = estimateTokens(
      buildSystemPrompt({
        hasRepositoryContext: mayHaveRepositoryContext,
        includeArtifactRules,
      })
    );

    // The ceiling is an assertion, not a floor: charge what was measured even when it
    // overruns, since under-charging is what pushes a request past the provider limit.
    // buildSystemPrompt has already warned by this point, naming the guilty layer.
    if (staticPromptTokens > SYSTEM_PROMPT_RESERVE) {
      logger.warn("Static system prompt exceeded its documented ceiling", {
        staticPromptTokens,
        ceiling: SYSTEM_PROMPT_RESERVE,
      });
    }

    const totalBudget =
      maxContext - maxOutput - staticPromptTokens - safetyMargin - imageHeadroom;
    let budget = totalBudget;

    // --- 1. Extract attachments from history so they do not bloat the window ------
    const allDocs: { name: string; content: string }[] = [];
    const cleanHistory: Message[] = [];

    for (const msg of historicalMessages) {
      if (typeof msg.content !== "string") continue;
      let content: string = msg.content;

      const match = content.match(ATTACHMENT_TAG_RE);
      if (match) {
        try {
          const meta: unknown = JSON.parse(match[1]);
          const entries =
            isRecord(meta) && Array.isArray(meta.attachments) ? meta.attachments : [];
          for (const entry of entries) {
            if (!isRecord(entry) || entry.type !== "document") continue;
            const extractedText = entry.extractedText;
            if (typeof extractedText === "string" && extractedText.length > 0) {
              const name = typeof entry.name === "string" ? entry.name : "attachment";
              allDocs.push({ name, content: extractedText });
            }
          }
          content = content.replace(ATTACHMENT_TAG_RE, "").trim();
        } catch {
          // Malformed metadata: keep the message text, skip its attachments.
        }
      }

      cleanHistory.push({
        id: msg.id ?? "",
        role:
          msg.role === "system"
            ? "system"
            : msg.role === "user"
              ? "user"
              : msg.role === "assistant"
                ? "assistant"
                : "data",
        content,
      });
    }

    // queryStr is computed above, before the budget, because the prompt's size
    // depends on it.
    const terms = queryTerms(queryStr);

    // --- 2. Current request has absolute priority --------------------------------
    const queryTokens = estimateTokens(queryStr);
    if (queryTokens > budget) {
      throw new ContextOverflowError(
        `This message is too large for the model's context window on its own ` +
          `(about ${queryTokens.toLocaleString("en-US")} tokens, limit ${budget.toLocaleString("en-US")}). ` +
          `It has not been truncated. Please split it into smaller parts, or attach large ` +
          `files instead of pasting them so CodeMind can retrieve only the relevant sections.`,
        queryTokens,
        budget
      );
    }
    budget -= queryTokens;

    let contextBlocks = "";
    /** Paths rendered in full this turn. See BuildContextResult.repositoryFilesWhole. */
    const repositoryFilesWhole: string[] = [];

    // --- 2b. Project workspace context -------------------------------------------
    // Placed ahead of the summary and history so a busy project cannot push the
    // user's own standing rules out of the window.
    //
    // Each block is bounded by BOTH its share of the total budget and whatever is
    // actually left, and the wrapper text is charged against that same allowance. A
    // ratio-only cap was not enough: when the current message has already consumed
    // most of the window, `budget` went negative and the assembled prompt exceeded
    // the model's context limit by up to the size of these two blocks.
    if (options.projectInstructions && options.projectInstructions.trim().length > 0) {
      const header = `

--- PROJECT INSTRUCTIONS ---
These apply to every conversation in this project. Follow them unless the user's current message overrides them.
`;
      const allowance =
        Math.min(Math.floor(totalBudget * PROJECT_INSTRUCTIONS_RATIO), Math.max(0, budget)) -
        estimateTokens(header);
      const instructions = clampToTokens(options.projectInstructions.trim(), allowance);
      if (instructions.length > 0) {
        const block = `${header}${instructions}`;
        contextBlocks += block;
        budget -= estimateTokens(block);
      }
    }

    if (options.projectMemory && options.projectMemory.length > 0) {
      const rendered = options.projectMemory
        .filter((section) => section.items.length > 0)
        .map((section) => `${section.title}: ${section.items.join(", ")}`)
        .join("\n");

      if (rendered.length > 0) {
        const header = `

--- PROJECT MEMORY ---
Durable facts about this project:
`;
        const allowance =
          Math.min(Math.floor(totalBudget * PROJECT_MEMORY_RATIO), Math.max(0, budget)) -
          estimateTokens(header);
        const memory = clampToTokens(rendered, allowance);
        if (memory.length > 0) {
          const block = `${header}${memory}`;
          contextBlocks += block;
          budget -= estimateTokens(block);
        }
      }
    }

    // --- 2c. Repository source files ---------------------------------------------
    // After the project's own instructions and memory, before the summary: the user's
    // standing rules outrank code, and code outranks compressed history of old turns.
    //
    // Files are packed WHOLE or not at all. A file cut in half still reads to the model
    // as a complete file, which is how a confident answer about a function that was
    // truncated away happens. Clamping applies only to a single file that cannot fit on
    // its own, where the alternative is showing nothing of it.
    // A failure notice with no files. Deliberately its own branch: it must render when
    // there is nothing to render beside it.
    if (options.repositoryNote) {
      /**
       * One field, two headers. The note used to render ONLY when there were no files,
       * because "unavailable" was the only thing a caller ever had to say. An edit turn
       * needs to say something when the file IS present — that the whole file is in
       * view and a whole file is wanted back — and that is the same kind of per-turn
       * repository instruction, so it travels the same way rather than growing a second
       * channel beside it.
       */
      const header =
        !options.repositoryFiles || options.repositoryFiles.length === 0
          ? "--- REPOSITORY CONTEXT UNAVAILABLE ---"
          : "--- REPOSITORY TURN NOTE ---";
      const notice = `

${header}
${options.repositoryNote}
`;
      if (estimateTokens(notice) <= budget) {
        contextBlocks += notice;
        budget -= estimateTokens(notice);
      }
    }

    if (options.repositoryFiles && options.repositoryFiles.length > 0) {
      const header = `

--- REPOSITORY FILES ---
Source from the repository this project is about. Paths are relative to the repo root.
`;
      const allowance =
        Math.min(Math.floor(totalBudget * REPOSITORY_FILE_RATIO), Math.max(0, budget)) -
        estimateTokens(header);

      const rendered: string[] = [];
      let used = 0;

      for (const file of options.repositoryFiles) {
        const block = `
=== ${file.path} ===
${file.content}`;
        const cost = estimateTokens(block);

        if (used + cost <= allowance) {
          rendered.push(block);
          // Recorded ONLY on this branch — the one where the whole block fit. The
          // clamp below and the `break` after it both leave the path absent, which is
          // what makes absence trustworthy.
          repositoryFilesWhole.push(file.path);
          used += cost;
          continue;
        }

        // Only the first file may be clamped, and only when nothing has fit yet:
        // otherwise a large file late in the list would be silently halved while
        // smaller complete files were available.
        if (rendered.length === 0 && allowance > 0) {
          const clamped = clampToTokens(block, allowance);
          if (clamped.length > 0) {
            rendered.push(clamped);
            used += estimateTokens(clamped);
          }
        }
        break;
      }

      if (rendered.length > 0) {
        const block = `${header}${rendered.join("\n")}`;
        contextBlocks += block;
        budget -= estimateTokens(block);
      }
    }

    // --- 3. Rolling summary (long-term compressed memory) ------------------------
    if (existingSummary) {
      const cap = Math.min(Math.floor(totalBudget * SUMMARY_BUDGET_RATIO), budget);
      const summaryText = clampToTokens(existingSummary, cap);
      if (summaryText.length > 0) {
        const block = `\n\n--- CONVERSATION MEMORY ---\nThe following is a summary of older conversation context:\n${summaryText}`;
        contextBlocks += block;
        budget -= estimateTokens(block);
      }
    }

    // --- 4. Attachment retrieval (unchanged strategy, now budget-capped) ---------
    if (allDocs.length > 0 && terms.length > 0) {
      const scored: { text: string; score: number; docName: string }[] = [];
      for (const doc of allDocs) {
        for (const chunk of chunkText(doc.content)) {
          const score = scoreText(chunk, terms);
          if (score > 0) scored.push({ text: chunk, score, docName: doc.name });
        }
      }
      scored.sort((a, b) => b.score - a.score);

      const cap = Math.min(Math.floor(totalBudget * ATTACHMENT_RETRIEVAL_RATIO), budget);
      const selected: string[] = [];
      let used = 0;

      for (const chunk of scored.slice(0, MAX_ATTACHMENT_CHUNKS)) {
        const rendered = `[From ${chunk.docName}]:\n${chunk.text}`;
        const cost = estimateTokens(rendered);
        if (used + cost > cap) break;
        used += cost;
        selected.push(rendered);
      }

      if (selected.length > 0) {
        const block = `\n\n--- RELEVANT ATTACHMENT CHUNKS ---\n${selected.join("\n\n")}`;
        contextBlocks += block;
        budget -= estimateTokens(block);
      }
    }

    // --- 5. Recent history, packed as whole turns --------------------------------
    // Reserve space for historical retrieval first so it cannot be crowded out.
    const retrievalReserve = options.retrievalCandidates?.length
      ? Math.min(Math.floor(totalBudget * CONVERSATION_RETRIEVAL_RATIO), Math.max(0, budget))
      : 0;

    const fixedUsed = totalBudget - budget;
    const level = pressureLevel(totalBudget > 0 ? fixedUsed / totalBudget : 1);
    const allowance = Math.min(
      turnAllowanceFor(level),
      options.maxRecentTurns ?? Number.POSITIVE_INFINITY
    );

    const turns = groupIntoTurns(cleanHistory);
    const historyBudget = Math.max(0, budget - retrievalReserve);

    const keptTurns: Turn[] = [];
    const droppedTurns: Turn[] = [];
    let historyUsed = 0;

    // Newest first. Stop at the first turn that does not fit: everything older is
    // dropped as a block, which guarantees the retained window stays contiguous.
    let stopped = false;
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (stopped || keptTurns.length >= allowance || historyUsed + turn.tokens > historyBudget) {
        stopped = true;
        droppedTurns.unshift(turn);
        continue;
      }
      historyUsed += turn.tokens;
      keptTurns.unshift(turn);
    }

    budget -= historyUsed;

    const finalHistory: Message[] = keptTurns.flatMap((t) => t.messages);
    const keptIds = new Set(finalHistory.map((m) => m.id).filter(Boolean) as string[]);

    const droppedMessages = droppedTurns.flatMap((t) => t.messages);
    const droppedMessageIds = droppedMessages.map((m) => m.id).filter(Boolean) as string[];
    const droppedMessagesContent = droppedMessages
      .map((m) => `${String(m.role).toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n\n")
      .trim();

    // --- 6. Historical conversation retrieval ------------------------------------
    const retrievedMessageIds: string[] = [];

    if (options.retrievalCandidates?.length && terms.length > 0 && retrievalReserve > 0) {
      const candidateTurns = groupIntoTurns(
        options.retrievalCandidates.map((m) => ({
          id: m.id,
          role: (m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "data") as Message["role"],
          content: m.content,
        }))
      );

      const scoredTurns = candidateTurns
        // Skip anything already visible in the recent window.
        .filter((turn) => !turn.messages.some((m) => m.id && keptIds.has(m.id)))
        .map((turn) => {
          const text = turn.messages
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("\n");
          // Term overlap is the gate; the decision boost only reorders turns that
          // already match. Otherwise any turn containing "because" would be treated
          // as relevant to every question.
          const overlap = scoreText(text, terms);
          return { turn, text, score: overlap > 0 ? overlap + decisionBoost(text) : 0 };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      const selected: string[] = [];
      let used = 0;

      for (const entry of scoredTurns.slice(0, MAX_RETRIEVED_TURNS)) {
        // Keep retrieved units small and coherent rather than pasting whole turns.
        const rendered = entry.turn.messages
          .map((m) => {
            const body = typeof m.content === "string" ? m.content : "";
            const trimmed =
              body.length > RETRIEVED_MESSAGE_MAX_CHARS
                ? `${body.slice(0, RETRIEVED_MESSAGE_MAX_CHARS).trimEnd()}…`
                : body;
            return `${String(m.role).toUpperCase()}: ${trimmed}`;
          })
          .join("\n");

        const cost = estimateTokens(rendered);
        if (used + cost > retrievalReserve) break;

        used += cost;
        selected.push(rendered);
        for (const m of entry.turn.messages) {
          if (m.id) retrievedMessageIds.push(m.id);
        }
      }

      if (selected.length > 0) {
        const block = `\n\n--- RELEVANT EARLIER CONVERSATION ---\nExcerpts from earlier in this same conversation that relate to the current question:\n\n${selected.join("\n\n---\n\n")}`;
        contextBlocks += block;
        budget -= estimateTokens(block);
      }
    }

    // --- 7. Assemble -------------------------------------------------------------
    // Conversational persona only. Artifact generation is a separate server-side
    // pipeline (lib/artifacts/*), so the chat model is never told how to emit
    // artifact markup — which is what keeps source files out of visible replies.
    //
    // The persona itself lives in lib/ai/system-prompt.ts, composed from four layers
    // (identity, capabilities, task context, guardrails) with the guardrails last so
    // they outrank anything the assembled context happens to say. That layer encodes
    // three production failure modes and is documented at length there; this function
    // only supplies the task-context layer it budgeted above.
    //
    // Two conditional layers, decided from what this turn actually has:
    //
    //   grounding      only when repository files survived budgeting. Checked against
    //                  the RENDERED block, not options.repositoryFiles — a file list
    //                  that was passed in but priced out leaves nothing for the model
    //                  to cite, and grounding rules pointing at an absent block are
    //                  the confusing case they are meant to prevent. The budget above
    //                  reserved against the input list instead, which can only
    //                  over-reserve; see the note there.
    //   artifact rules decided from the user's own words, and computed with the budget
    //                  above so the prompt that was priced is the prompt that is built.
    const hasRepositoryContext = contextBlocks.includes("--- REPOSITORY FILES ---");

    const systemPrompt = buildSystemPrompt({
      contextBlocks,
      hasRepositoryContext,
      includeArtifactRules,
    });

    const used = totalBudget - budget;
    const ratio = totalBudget > 0 ? used / totalBudget : 1;

    return {
      messages: finalHistory,
      droppedMessageIds,
      droppedMessagesContent,
      systemPrompt,
      contextBlocks: contextBlocks.trim(),
      repositoryFilesWhole,
      pressure: { used, total: totalBudget, ratio, level: pressureLevel(ratio) },
      retrievedMessageIds,
    };
  }
}
