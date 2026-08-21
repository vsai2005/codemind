import { Message } from "ai";
import { ATTACHMENT_TAG_RE } from "@/lib/attachments";

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

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_MAX_CONTEXT_TOKENS = 128000;

/** Flat reserve for the base persona prompt. */
const SYSTEM_PROMPT_RESERVE = 300;

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

const MAX_RETRIEVED_TURNS = 3;
const RETRIEVED_MESSAGE_MAX_CHARS = 1200;
const MAX_ATTACHMENT_CHUNKS = 5;
const ATTACHMENT_CHUNK_SIZE = 1500;

export function getOutputTokenLimit(): number {
  const envVal = process.env.AI_MAX_OUTPUT_TOKENS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

export function getContextTokenLimit(): number {
  const envVal = process.env.AI_CONTEXT_MAX_TOKENS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CONTEXT_TOKENS;
}

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

function queryTerms(query: string): string[] {
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

export class ContextManager {
  static buildContext(
    historicalMessages: any[],
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
      let content = msg.content;
      if (typeof content !== "string") continue;

      const match = content.match(ATTACHMENT_TAG_RE);
      if (match) {
        try {
          const meta = JSON.parse(match[1]);
          const docAttachments = meta.attachments?.filter((a: any) => a.type === "document") || [];
          for (const doc of docAttachments) {
            if (doc.extractedText) {
              allDocs.push({ name: doc.name, content: doc.extractedText });
            }
          }
          content = content.replace(ATTACHMENT_TAG_RE, "").trim();
        } catch {
          // Malformed metadata: keep the message text, skip its attachments.
        }
      }

      cleanHistory.push({
        id: msg.id,
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
          `(about ${queryTokens.toLocaleString()} tokens, limit ${budget.toLocaleString()}). ` +
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
    if (options.projectInstructions && options.projectInstructions.trim().length > 0) {
      const instructions = clampToTokens(
        options.projectInstructions.trim(),
        Math.floor(totalBudget * PROJECT_INSTRUCTIONS_RATIO)
      );
      const block = `

--- PROJECT INSTRUCTIONS ---
These apply to every conversation in this project. Follow them unless the user's current message overrides them.
${instructions}`;
      contextBlocks += block;
      budget -= estimateTokens(block);
    }

    if (options.projectMemory && options.projectMemory.length > 0) {
      const rendered = options.projectMemory
        .filter((section) => section.items.length > 0)
        .map((section) => `${section.title}: ${section.items.join(", ")}`)
        .join("\n");

      if (rendered.length > 0) {
        const memory = clampToTokens(rendered, Math.floor(totalBudget * PROJECT_MEMORY_RATIO));
        const block = `

--- PROJECT MEMORY ---
Durable facts about this project:
${memory}`;
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
    const basePrompt = `You are CodeMind, a senior software engineer assistant.

Answer clearly and directly. When you show code, use fenced Markdown code blocks with a language tag.

Downloadable deliverables (project archives, PDFs, standalone files) are produced by a separate CodeMind pipeline. Never emit XML-style artifact or file tags such as <codemind_artifact> or <file path="...">; if a user wants a download, answer normally and CodeMind will handle packaging.`;

    const systemPrompt = basePrompt + contextBlocks;

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
