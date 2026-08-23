import { Message } from "ai";
import { ATTACHMENT_TAG_RE } from "@/lib/attachments";
import { getContextTokenLimit, getOutputTokenLimit } from "@/lib/env";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";

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
 * Flat reserve for the static persona layers (identity + capabilities + guardrails),
 * built by buildSystemPrompt in lib/ai/system-prompt.ts.
 *
 * Measured, not guessed: those three layers assemble to ~1,500 characters / ~377
 * estimated tokens. 400 leaves room to reword without silently under-reserving,
 * which would show up as an occasional context overflow rather than an obvious
 * error. It is mirrored there as STATIC_PROMPT_TOKEN_BUDGET, where per-layer
 * ceilings pin down which layer grew; keep the two numbers in step.
 */
const SYSTEM_PROMPT_RESERVE = 400;

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
 * Content-aware token estimate. Still an estimate — there is no Nemotron tokenizer
 * in this codebase and this function must never be presented as exact.
 *
 * Plain prose runs ~4.16 chars/token against the live API; dense code and JSON run
 * nearer 2.5–3.5 because punctuation splits aggressively. A flat /4 is therefore
 * conservative for prose but *optimistic* for code, which is the dangerous direction.
 * Punctuation density selects a divisor, and every divisor is rounded down from the
 * measured ratio so the estimate leans high.
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
    divisor = 2.5; // minified JSON, lockfiles, dense symbol soup
  } else if (punctuationRatio > 0.12) {
    divisor = 3.0; // typical TS/TSX/JSON
  } else if (punctuationRatio > 0.06) {
    divisor = 3.5; // code with prose comments
  } else {
    divisor = 4.0; // prose
  }

  // Long unbroken alphanumeric runs (base64, hashes, minified bundles) tokenize far
  // worse than their punctuation density suggests.
  if (longestRun > 60 && divisor > 3.0) divisor = 3.0;

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

/**
 * Split a question into the terms worth matching on.
 *
 * Exported because repository file selection asks the same question of a user's
 * message that retrieval does. `scoreText` below is deliberately NOT exported: it
 * scores prose, and paths need different weighting — see lib/repo/selection.ts for
 * why forcing that one to be shared would have been the wrong kind of reuse.
 */
export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\W+/)
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

    const totalBudget =
      maxContext - maxOutput - SYSTEM_PROMPT_RESERVE - safetyMargin - imageHeadroom;
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

    const queryStr =
      typeof newUserMessage.content === "string"
        ? newUserMessage.content
        : JSON.stringify(newUserMessage.content);
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
    const systemPrompt = buildSystemPrompt({ contextBlocks });

    const used = totalBudget - budget;
    const ratio = totalBudget > 0 ? used / totalBudget : 1;

    return {
      messages: finalHistory,
      droppedMessageIds,
      droppedMessagesContent,
      systemPrompt,
      contextBlocks: contextBlocks.trim(),
      pressure: { used, total: totalBudget, ratio, level: pressureLevel(ratio) },
      retrievedMessageIds,
    };
  }
}
