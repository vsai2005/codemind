import { streamText, generateText, type LanguageModelV1 } from "ai";
import { NextResponse } from "next/server";
import { HEADER_TIMEOUT_HEADER } from "@/lib/ai/fetch-timeout";
import { getVisionModel, nemotronOptions, NO_CAPACITY_CODE } from "@/lib/ai/gateway";
import { getDefaultModelId, getNvidiaVisionModelId, resolveModel } from "@/lib/ai/models/registry";
import { sdkRetriesFor } from "@/lib/ai/models/providers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import {
  ContextManager,
  ContextOverflowError,
  getOutputTokenLimit,
  type RetrievalMessage,
} from "@/lib/ai/context-manager";
import { attachmentBlockSchema, chatRequestSchema, formatIssues } from "@/types/chat";
import {
  splitAttachmentBlock,
  stripAttachmentTag,
  validateImageDataUrl,
  normalizeDocumentAttachment,
  type AllowedImageMimeType,
} from "@/lib/attachments";
import { detectArtifactIntent } from "@/lib/ai/intent";
import { generateArtifact } from "@/lib/artifacts/generate";
import {
  attemptFromReport,
  describeWarnings,
  type ArtifactAttempt,
  type VerificationReport,
} from "@/lib/artifacts/verify";
import { createArtifactStreamResponse } from "@/lib/artifacts/stream";
import { buildArtifactBytes } from "@/lib/artifacts/build";
import { enforceRateLimit, acquireGenerationSlot, concurrentGenerationLimit } from "@/lib/rate-limit";
import { scrubForLog } from "@/lib/ai/failure-classification";
import { GENERATION_SLOT_MAX_LIFETIME_MS } from "@/lib/ai/generation-window";
import { releaseOnStreamEnd } from "@/lib/ai/stream-lifecycle";
import { buildPlan, planToPromptBlock, type ChatPlan } from "@/lib/ai/planning";
import { createDataStreamPrefix } from "@/lib/ai/plan-stream";
import { guardChatStream } from "@/lib/ai/chat-output-guard";
import { logger } from "@/lib/logger";
// Prisma is used as a value here (Prisma.DbNull), not only as a type.
import { Prisma } from "@prisma/client";
import type { ArtifactMetadata, NormalizedArtifact } from "@/lib/artifacts/types";
import { enforceBodyLimit } from "@/lib/http/body-limit";
import {
  buildSummaryPrompt,
  validateSummary,
  SUMMARY_MAX_OUTPUT_TOKENS,
} from "@/lib/ai/summarization";
import { fetchFileContent } from "@/lib/repo/github";
import { detectEntryPoints } from "@/lib/repo/structure";
import {
  expandAlongEdges,
  fallbackFiles,
  hubFiles,
  scoreFiles,
  selectWithinBudget,
} from "@/lib/repo/selection";
import { createHash } from "node:crypto";

/**
 * How far back historical retrieval scans. Older turns than this are represented by
 * the rolling summary rather than retrieved verbatim, which bounds the query cost.
 */
const HISTORY_RETRIEVAL_SCAN_LIMIT = 600;

/**
 * True when the provider rejected the request for context length, as opposed to any
 * other failure. Matched against both the error text and the raw response body,
 * because the AI SDK wraps provider errors.
 */
function isProviderContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const body = (error as { responseBody?: unknown })?.responseBody;
  const haystack = `${message} ${typeof body === "string" ? body : ""}`.toLowerCase();

  return (
    haystack.includes("maximum context length") ||
    haystack.includes("context_length_exceeded") ||
    haystack.includes("reduce the length of the messages") ||
    haystack.includes("too many tokens")
  );
}

/**
 * Retry policy is per-PROVIDER, not a single constant — see `sdkRetriesFor`.
 *
 * It used to be a flat 0, on the reasoning that "the gateway already performs bounded
 * failover across API keys". That is true and still holds for NVIDIA: leaving the SDK
 * at its default of 2 would multiply against the gateway and fire up to nine upstream
 * calls for one turn. But the gateway only wraps NVIDIA. Google and DeepSeek are plain
 * single-credential clients with nothing behind them, so a flat 0 meant nothing in the
 * stack retried at all and one transient 429 ended the turn.
 */

/**
 * True when the provider accepted the connection but never sent response headers.
 * Distinct from a rate limit or a bad request: the model is listed but not actually
 * serving, which the user can only fix by choosing a different one.
 */
function isProviderTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown })?.cause;
  const causeMessage = cause instanceof Error ? cause.message : "";
  const haystack = `${message} ${causeMessage}`.toLowerCase();

  return (
    haystack.includes("no response headers within") ||
    haystack.includes("aborterror") ||
    haystack.includes("timeouterror") ||
    haystack.includes("the operation was aborted")
  );
}

/**
 * A token count only when the provider actually reported one, otherwise null.
 *
 * This guard is load-bearing, not defensive decoration. The AI SDK's
 * OpenAI-compatible streaming path initialises usage to `NaN` and only replaces it
 * on receiving a usage chunk, which an endpoint sends only when the request set
 * `stream_options.include_usage` — and @ai-sdk/openai sends that only under
 * `compatibility: "strict"`. NVIDIA is strict and does report; Google and DeepSeek
 * are still "compatible" and still arrive as NaN. `NaN` into an Int column is a
 * write error rather than a null, so every provider has to pass through here.
 *
 * Null therefore means "the provider did not report", never "zero tokens".
 */
function toTokenCount(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * How long a held idempotency key is assumed to belong to a request that is still
 * running. Matches the gateway's own stalled-lease backstop, which is the longest a
 * generation can legitimately stay open.
 *
 * CONSEQUENCE, and it is a real one: this is a heuristic, not a fact. The key is held
 * by a row in the database and nothing revokes it if the process dies mid-stream — a
 * deploy, a crash, an OOM. When that happens the key stays held with nothing behind
 * it, and a user retrying that message gets 409 "already being processed" until this
 * window elapses. They are told to wait and are not blocked permanently, but for up
 * to two minutes the API asserts a request is live when it is not.
 *
 * Shortening it trades that for the opposite error: deciding a slow-but-live
 * generation is dead and running a second one alongside it. Two minutes is where the
 * gateway itself abandons a stream, so a key outliving this really does imply nothing
 * is still running.
 */
const TURN_KEY_ASSUMED_LIVE_MS = 2 * 60_000;

/**
 * Backstop on a per-user generation slot, so an abandoned stream cannot hold one
 * forever.
 *
 * acquireGenerationSlot tracks concurrency in an in-memory map with a limit of three.
 * The slot is normally freed when the response body drains, errors, or is cancelled —
 * but a client that vanishes without a terminal signal (dropped connection, killed
 * mobile tab, a proxy giving up mid-stream) never produces one. Without a timeout that
 * slot is held until the process restarts, and after three of them the user is locked
 * out with an instant 429 "You already have 3 responses in progress" on every message,
 * which the browser then shows as nothing at all.
 *
 * The provider key lease in lib/ai/gateway.ts already does this; the generation slot
 * was simply never given the same treatment.
 *
 * Sized well above the longest legitimate generation rather than tightly: an artifact
 * run was measured at 43s and a slow chat turn at 26s, and reclaiming a slot from a
 * generation that is still streaming would cut off a reply the user is reading. Five
 * minutes is far past anything real and still bounds the leak.
 */
/** The value itself lives in lib/ai/generation-window.ts — see there for why. */

/**
 * How many indexed files are ranked for one question.
 *
 * Ranking is pure database work, so this bounds memory rather than API budget — 4,000
 * rows of path and size is well under a megabyte, which matters on a 512 MB instance.
 */
const REPOSITORY_SELECTION_SCAN_LIMIT = 4000;

/**
 * Share of the model's window that repository files may be fetched against.
 *
 * Slightly under the REPOSITORY_FILE_RATIO the context manager packs with, so
 * selection cannot fetch more than packing will accept. Overshooting would spend
 * GitHub requests on files that are then dropped for space — the exact waste the
 * size-based budgeting exists to avoid.
 */
const REPOSITORY_FETCH_ALLOWANCE_RATIO = 0.3;

/**
 * Files read per question.
 *
 * One request each against a budget shared by every user, so this is the per-turn cost
 * of the whole feature. Three is enough to answer "how does X work" for a file and its
 * closest neighbours, and small enough that a conversation cannot quietly drain the
 * pool. Raising it is the first thing to try when selection is right but the answer is
 * thin — and the first thing to suspect when the budget disappears.
 */
const MAX_REPOSITORY_FILES_PER_TURN = 3;

/**
 * How many files are expanded along the import graph, and the ceiling on rows read to
 * do it.
 *
 * The seed count is small because expansion bets that the answer sits next to the best
 * match, and that bet is only good where the match is strong. The scan limit is a
 * backstop, not an expected size: the query is two index lookups against a handful of
 * seed ids, so reaching it would mean a seed with thousands of importers — in which
 * case truncating is the right outcome, since `neighboursOf` would discard them anyway.
 */
const REPOSITORY_EDGE_SEEDS = 4;
const REPOSITORY_EDGE_SCAN_LIMIT = 2000;

/**
 * How much of the user's question is echoed into the empty-selection warning.
 *
 * Enough to recognise which turn failed and reproduce it, short enough that a pasted
 * stack trace or file cannot fill the log. The value is scrubbed before truncation, so
 * a credential pasted into a question does not reach the logs either.
 */
const REPOSITORY_QUERY_LOG_CHARS = 120;

/**
 * Stable identifier for "this turn", used to make a retry a resume instead of a
 * second write.
 *
 * Always hashed together with the user id, which is what scopes it: two users
 * supplying the same client key, or sending identical text, produce different digests
 * and cannot see or overwrite each other's turns. Hashing also keeps the stored value
 * opaque and fixed-width, so no user-controlled string is ever matched directly.
 *
 * With no client key, one is derived from the request itself — the conversation it
 * targets plus the exact message text. The browser needs no change for that to work,
 * and it is what actually closes the duplicate paths here, because every duplicate
 * comes from a user resending rather than from one HTTP request arriving twice.
 */
function turnKeyFor(
  userId: string,
  clientKey: string | null | undefined,
  conversationId: string | null | undefined,
  content: string
): string {
  const identity = clientKey
    ? `client ${clientKey}`
    : `derived ${conversationId ?? "new"} ${content}`;
  return createHash("sha256").update(`${userId} ${identity}`).digest("hex");
}

/** True when a write lost a race against the unique index on Message.idempotencyKey. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** True when every provider key was busy or cooling down. */
function isNoCapacityError(error: unknown): boolean {
  const body = (error as { responseBody?: unknown })?.responseBody;
  const message = error instanceof Error ? error.message : "";
  return (
    (typeof body === "string" && body.includes(NO_CAPACITY_CODE)) ||
    message.includes(NO_CAPACITY_CODE)
  );
}

interface PreparedImage {
  mediaType: AllowedImageMimeType;
  data: Uint8Array;
}

interface PreparedMessage {
  /** The user's own text, attachment markup removed. Used for intent detection. */
  userText: string;
  /** User text plus inlined document contents. Sent to the model. */
  promptText: string;
  image: PreparedImage | null;
}

/**
 * Re-derive the model input from a raw message. Attachment metadata from the browser
 * is validated here rather than trusted: documents are clamped, and images must be
 * CodeMind-produced data URLs whose magic bytes match their declared type.
 */
function prepareUserMessage(
  rawContent: string
): { ok: true; value: PreparedMessage } | { ok: false; reason: string } {
  const { text, raw } = splitAttachmentBlock(rawContent);

  if (raw === null) {
    return { ok: true, value: { userText: text, promptText: text, image: null } };
  }

  let parsedBlock: unknown;
  try {
    parsedBlock = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "attachment metadata is not valid JSON" };
  }

  const block = attachmentBlockSchema.safeParse(parsedBlock);
  if (!block.success) {
    return { ok: false, reason: `invalid attachment metadata (${formatIssues(block.error)})` };
  }

  let promptText = text;
  let image: PreparedImage | null = null;

  const documents = block.data.attachments.filter((a) => a.type === "document");
  if (documents.length > 0) {
    const rendered: string[] = [];
    for (const doc of documents) {
      const normalized = normalizeDocumentAttachment(doc.name, doc.extractedText);
      if (normalized) {
        rendered.push(`\nDocument: ${normalized.name}\n${normalized.extractedText}\n`);
      }
    }
    if (rendered.length > 0) {
      promptText += `\n\n--- ATTACHED DOCUMENTS ---\n${rendered.join("")}`;
    }
  }

  const firstImage = block.data.attachments.find((a) => a.type === "image");
  if (firstImage && firstImage.type === "image") {
    const check = validateImageDataUrl(firstImage.url);
    if (!check.ok) return { ok: false, reason: check.reason };
    image = { mediaType: check.mediaType, data: check.data };
  }

  return { ok: true, value: { userText: text, promptText, image } };
}

function deriveTitle(rawContent: string): string {
  const clean = stripAttachmentTag(rawContent).replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "New Conversation";
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

/**
 * Summarize messages that fell out of the sliding window, folding them into the
 * conversation's long-term memory. Failures are logged and swallowed — losing a
 * summary must never fail the user's request.
 */
async function summarizeDropped(
  conversationId: string,
  userId: string,
  existingSummary: string | null,
  /** Version read alongside `existingSummary`. The write is conditional on it. */
  existingSummaryVersion: number,
  droppedMessagesContent: string
): Promise<void> {
  if (!droppedMessagesContent) return;

  // Conversation memory is model-neutral: one summary serves whichever model the
  // user has selected. Using the selected model here would make the summary's
  // character depend on who happened to be answering when it was written.
  const summaryModel = resolveModel(process.env.CODEMIND_SUMMARY_MODEL || getDefaultModelId());

  try {
    const summaryResult = await generateText({
      model: summaryModel.model,
      maxRetries: sdkRetriesFor(summaryModel.descriptor.provider),
      prompt: buildSummaryPrompt({ existingSummary, droppedMessagesContent }),
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });

    // Checked BEFORE it is written, because this string is replayed into every later
    // system prompt for this conversation. A rejected summary leaves the previous one
    // standing, which is strictly better than persisting markup — or nothing.
    const validation = validateSummary(summaryResult.text);
    if (!validation.ok) {
      logger.warn("Rejected a generated conversation summary", {
        conversationId,
        reason: validation.reason,
      });
      return;
    }

    // Conditional on the version that was read. Two turns in one conversation can
    // summarize at once — summarization is detached from the request — and each merges
    // into the summary it read at the start. Without the version in the filter the
    // slower write silently discards the other's memory, and the result still looks
    // like a perfectly good summary, so nothing would ever surface the loss.
    //
    // updateMany rather than update: it matches zero rows instead of throwing when the
    // version has moved on, and keeps ownership in the filter the database enforces.
    const written = await prisma.conversation.updateMany({
      where: { id: conversationId, userId, summaryVersion: existingSummaryVersion },
      data: {
        summary: validation.summary,
        summaryVersion: existingSummaryVersion + 1,
      },
    });

    if (written.count === 0) {
      // Lost the race. Non-fatal by design: the winner's summary already covers its
      // own dropped messages, and this turn's messages are folded in by the next
      // summarization, which reads the newer version. Nothing is retried here — a
      // retry loop against a conversation under sustained load would not converge.
      logger.info("Discarded a summary that lost the version race", {
        conversationId,
        expectedVersion: existingSummaryVersion,
      });
      return;
    }

    logger.debug("Conversation summary updated", {
      conversationId,
      version: existingSummaryVersion + 1,
      chars: validation.summary.length,
    });
  } catch (error) {
    logger.warn("Background summarization failed", {
      conversationId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const limited = enforceRateLimit("chat", req, userId);
    if (limited) return limited;

    // Concurrency, not just rate. A generation holds a provider key for as long as it
    // streams, so without this one user could open many slow-reading streams and hold
    // the entire shared key pool — something a per-minute request limit cannot prevent.
    const releaseSlot = acquireGenerationSlot(userId);
    if (!releaseSlot) {
      return NextResponse.json(
        {
          error: `You already have ${concurrentGenerationLimit()} responses in progress. Wait for one to finish and try again.`,
        },
        { status: 429, headers: { "Retry-After": "5" } }
      );
    }

    // Any early return past this point must free the slot, so the whole remaining body
    // runs inside a try/finally-style guard: the slot is released on every failure path
    // here, and handed to the response stream on the success paths.
    let slotHandedToStream = false;
    const releaseIfUnhanded = (): void => {
      if (!slotHandedToStream) releaseSlot();
    };

    try {

    let body: unknown;
    try {
      const oversized = enforceBodyLimit(req, "chat");
      if (oversized) return oversized;
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Invalid chat request: ${formatIssues(parsed.error)}` },
        { status: 400 }
      );
    }
    const { messages, conversationId } = parsed.data;

    // --- Idempotency -------------------------------------------------------------
    // Resolved BEFORE the conversation is created or looked up, because one of the
    // duplicates this closes is a second CONVERSATION: a retry from the dashboard
    // carries no conversationId, so without this it would open a new one and file the
    // repeated message there.
    const turnKey = turnKeyFor(
      userId,
      parsed.data.idempotencyKey,
      conversationId,
      messages[messages.length - 1].content
    );

    // A held key means an earlier attempt at this same turn wrote its user message and
    // never finished — the key is cleared when the assistant reply is persisted, so a
    // completed turn leaves nothing here and a legitimate repeat is never blocked.
    const heldTurn = await prisma.message.findUnique({
      where: { idempotencyKey: turnKey },
      select: { id: true, conversationId: true, createdAt: true },
    });

    // Reused rather than re-inserted when an abandoned attempt is resumed.
    let existingUserMessageId: string | null = null;
    // Forces the resumed turn back onto its original conversation.
    let resumedConversationId: string | null = null;

    if (heldTurn) {
      if (Date.now() - heldTurn.createdAt.getTime() < TURN_KEY_ASSUMED_LIVE_MS) {
        // Still inside the window where a request could plausibly be streaming. We
        // cannot join someone else's stream without process-local coordination, so
        // say so plainly rather than silently duplicating the turn. See
        // TURN_KEY_ASSUMED_LIVE_MS for when this answer is wrong.
        logger.warn("Rejected duplicate chat request; original may still be running", {
          conversationId: heldTurn.conversationId,
        });
        return NextResponse.json(
          {
            error:
              "That message is already being processed. Wait a moment for the reply, or try again shortly.",
          },
          {
            status: 409,
            headers: {
              "Retry-After": "5",
              "x-conversation-id": heldTurn.conversationId,
            },
          }
        );
      }

      // Old enough that nothing can still be generating it. Pick the turn back up
      // where it stopped: same conversation, same user message, new attempt at a reply.
      existingUserMessageId = heldTurn.id;
      resumedConversationId = heldTurn.conversationId;
      logger.info("Resuming an abandoned turn instead of duplicating it", {
        conversationId: heldTurn.conversationId,
      });
    }

    // Ownership is always derived from the session, never from the request body.
    let activeConversationId: string;
    let existingSummary: string | null = null;
    // Read with the summary so the eventual write can be conditional on it. A new
    // conversation starts at the column default.
    let existingSummaryVersion = 0;

    let activeProjectId: string | null = null;

    // A resumed turn keeps its original conversation even when the retry forgot to
    // name one, which is exactly the dashboard case.
    const targetConversationId = resumedConversationId ?? conversationId;

    if (!targetConversationId) {
      // A projectId from the client is only honoured if the caller owns that project.
      let projectId: string | null = null;
      if (parsed.data.projectId) {
        const owned = await prisma.project.findFirst({
          where: { id: parsed.data.projectId, userId },
          select: { id: true },
        });
        if (!owned) {
          return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }
        projectId = owned.id;
      }

      const created = await prisma.conversation.create({
        data: { title: deriveTitle(messages[0].content), userId, projectId },
      });
      activeConversationId = created.id;
      activeProjectId = projectId;
    } else {
      const existing = await prisma.conversation.findFirst({
        where: { id: targetConversationId, userId },
      });
      if (!existing) {
        return NextResponse.json(
          { error: "Conversation not found or unauthorized" },
          { status: 404 }
        );
      }
      activeConversationId = existing.id;
      existingSummary = existing.summary;
      existingSummaryVersion = existing.summaryVersion;
      activeProjectId = existing.projectId;
    }

    const lastMessage = messages[messages.length - 1];
    const originalRawContent = lastMessage.content;

    const prepared = prepareUserMessage(originalRawContent);
    if (!prepared.ok) {
      return NextResponse.json({ error: prepared.reason }, { status: 400 });
    }
    const { userText, promptText, image } = prepared.value;

    if (promptText.trim().length === 0 && !image) {
      return NextResponse.json({ error: "Message is empty" }, { status: 400 });
    }

    const historicalMessages = messages.slice(0, -1);
    const activeUserMessage = { ...lastMessage, content: promptText } as never;

    // Historical retrieval candidates are loaded server-side and scoped through the
    // conversation relation to the authenticated user. The request body is never
    // trusted as a source of history, and no other conversation is reachable.
    const retrievalRows = await prisma.message.findMany({
      where: { conversationId: activeConversationId, conversation: { userId } },
      select: { id: true, role: true, content: true },
      orderBy: { createdAt: "desc" },
      take: HISTORY_RETRIEVAL_SCAN_LIMIT,
    });
    const retrievalCandidates: RetrievalMessage[] = retrievalRows
      .reverse()
      .map((row) => ({ id: row.id, role: row.role, content: stripAttachmentTag(row.content) }));

    // Model resolution is a server decision. The client sends a CodeMind id; the
    // registry decides whether it is real, which provider serves it, and what limits
    // apply. An unregistered id never reaches a provider API.
    const requestedModelId = parsed.data.model ?? getDefaultModelId();
    let resolved;
    try {
      resolved = resolveModel(requestedModelId);
    } catch (error) {
      logger.warn("Rejected model selection", {
        requestedModelId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return NextResponse.json(
        { error: "That model is not available. Pick a different one and try again." },
        { status: 400 }
      );
    }

    // Project workspace context. Scoped by userId as well as id, so a conversation
    // that somehow referenced another user's project would still read nothing.
    let projectInstructions: string | null = null;
    let projectMemory: Array<{ title: string; items: string[] }> | null = null;
    /** Set only for a project backed by a fully indexed repository. */
    let repository: {
      id: string;
      owner: string;
      name: string;
      commitSha: string;
      entryPoints: string[];
      /**
       * Whether an import graph exists for this snapshot. Carried rather than inferred
       * from an empty edge query, because "no edges" and "never parsed" would otherwise
       * be the same observation — the distinction Repository.importsExtracted exists
       * for, and the reason a Python repo must not look like a repo with no imports.
       */
      importsExtracted: boolean;
    } | null = null;

    if (activeProjectId) {
      const project = await prisma.project.findFirst({
        where: { id: activeProjectId, userId },
        select: {
          instructions: true,
          memory: true,
          // Loaded with the project the route already reads, so a repo-backed
          // conversation costs no extra query.
          repository: {
            select: {
              id: true,
              owner: true,
              name: true,
              commitSha: true,
              status: true,
              // Detected at ingestion, used when path scoring finds nothing.
              structure: true,
              importsExtracted: true,
            },
          },
        },
      });
      if (project) {
        /**
         * Only a `ready` index is usable, and a partial one is ignored entirely rather
         * than used with a caveat.
         *
         * A caveat does not work here: people read answers, not warnings. An answer
         * drawn from 40% of a repository is indistinguishable from a complete one —
         * same confident tone, same specific file names — so the only honest options
         * are a full index or none. Ignoring it means the model answers from the
         * conversation alone, which is at least a failure mode users recognise.
         */
        if (project.repository?.status === "ready") {
          const structure = project.repository.structure as { entryPoints?: unknown } | null;
          const entryPoints = Array.isArray(structure?.entryPoints)
            ? structure.entryPoints.filter((p): p is string => typeof p === "string")
            : [];
          repository = {
            id: project.repository.id,
            owner: project.repository.owner,
            name: project.repository.name,
            commitSha: project.repository.commitSha,
            entryPoints,
            importsExtracted: project.repository.importsExtracted,
          };
        }
        projectInstructions = project.instructions;
        const raw = project.memory;
        if (Array.isArray(raw)) {
          projectMemory = raw.flatMap((entry) => {
            if (typeof entry !== "object" || entry === null) return [];
            const section = entry as Record<string, unknown>;
            if (typeof section.title !== "string") return [];
            const items = Array.isArray(section.items)
              ? section.items.filter((i): i is string => typeof i === "string")
              : [];
            return items.length > 0 ? [{ title: section.title, items }] : [];
          });
        }
      }
    }

    /**
     * Source files for a repo-backed question.
     *
     * Selection reads only the stored index — path, size, language — so ranking and
     * budgeting cost no GitHub requests; a request is spent only on a file that has
     * already been chosen and priced. Fetching happens here rather than inside
     * ContextManager because that module is synchronous and must stay free of network
     * calls; it receives the finished text and budgets it like every other layer.
     *
     * Entirely additive: a conversation with no indexed repository takes none of this
     * and reaches buildContext exactly as before.
     */
    let repositoryFiles: Array<{ path: string; content: string }> | undefined;
    /**
     * Told to the model when the repository could not be read.
     *
     * The alternative is what used to happen: no files, no note, and an answer written
     * as though the repository were empty. A model cannot report a gap it was never
     * told about, and the user cannot see one that never appears in the reply.
     */
    let repositoryNote: string | undefined;

    if (repository) {
      const selection = await loadRepositoryFiles({
        repository,
        question: userText,
        contextTokens: resolved.effectiveContextTokens,
      });

      repositoryFiles = selection.files.length > 0 ? selection.files : undefined;

      if (selection.loadFailed) {
        repositoryNote =
          "The repository attached to this project could not be read for this message, " +
          "so none of its source is available here. Say so plainly before answering, " +
          "and do not describe the repository's code as though you had seen it.";
      }
    }

    const buildContext = (maxRecentTurns?: number) =>
      ContextManager.buildContext(historicalMessages, activeUserMessage, existingSummary, {
        hasImage: Boolean(image),
        retrievalCandidates,
        maxRecentTurns,
        // Budget follows the selected model, so switching models mid-conversation
        // rebuilds context against the new model's limits rather than reusing the old.
        contextTokens: resolved.effectiveContextTokens,
        outputTokens: resolved.effectiveOutputTokens,
        projectInstructions,
        projectMemory,
        repositoryFiles,
        repositoryNote,
      });

    let context = buildContext();

    logger.debug("Context assembled", {
      conversationId: activeConversationId,
      pressure: context.pressure.level,
      ratio: Number(context.pressure.ratio.toFixed(3)),
      historyMessages: context.messages.length,
      retrievedMessages: context.retrievedMessageIds.length,
      droppedMessages: context.droppedMessageIds.length,
    });

    // Artifact requests are detected server-side, before any generation.
    // Vision requests stay on the normal chat path so image reasoning is preserved.
    const intent = image ? null : detectArtifactIntent(userText);

    // Planning stage. Runs before generation on a small, targeted slice of context —
    // the request plus assembled memory, never the full window. Returns null for
    // trivial asks or on any failure, in which case generation proceeds unplanned.
    const plan = await buildPlan({
      userText,
      contextBlocks: context.contextBlocks,
      modelId: resolved.descriptor.id,
    });

    // The plan augments the prompt; the user's original words are still sent verbatim.
    const plannedPrompt = plan ? `${promptText}${planToPromptBlock(plan)}` : promptText;

    if (intent) {
      const artifactResponse = handleArtifactRequest({
        intent: intent.type,
        promptText: plannedPrompt,
        plan,
        contextBlocks: context.contextBlocks,
        conversationId: activeConversationId,
        originalRawContent,
        existingSummary,
        existingSummaryVersion,
        droppedMessagesContent: context.droppedMessagesContent,
        model: resolved.model,
        provider: resolved.descriptor.provider,
        providerModelId: resolved.descriptor.providerModelId,
        // This dispatch returns before the streaming path's header-timeout block, so
        // the budget has to travel with the request rather than being applied there.
        headerTimeoutMs: resolved.descriptor.headerTimeoutMs,
        // The registry's declared ceiling for this model. Artifact generation used to
        // send a flat env value that ignored it, asking 8192-token models for 16000.
        modelMaxOutputTokens: resolved.descriptor.maxOutputTokens,
        userId,
      });

      // The generation outlives this function, so the slot travels with the stream.
      //
      // continueOnCancel for the same reason as the chat path, and with more at stake:
      // an artifact turn ends by building a file and persisting it, so aborting it
      // partway spends the expensive generation and produces no download at all.
      slotHandedToStream = true;
      return releaseOnStreamEnd(artifactResponse, {
        onSettled: releaseSlot,
        continueOnCancel: true,
        timeoutMs: GENERATION_SLOT_MAX_LIFETIME_MS,
        onTimeout: () => {
          logger.warn("Reclaimed a generation slot from an abandoned artifact stream", {
            conversationId: activeConversationId,
          });
          releaseSlot();
        },
      });
    }

    // Vision compatibility. Three distinct cases, none of which silently drops the image:
    //   - the selected model sees images natively -> use it directly;
    //   - it does not, but it is NVIDIA -> route to the existing NVIDIA vision model,
    //     preserving the behaviour that shipped before multi-model support;
    //   - it does not, and no vision path exists for that provider -> say so plainly.
    let model = resolved.model;
    let modelOptions: Record<string, unknown> = resolved.descriptor.provider === "nvidia" ? nemotronOptions : {};
    let effectiveProviderModelId = resolved.descriptor.providerModelId;

    /**
     * A model measured to be slow to first byte carries its own header-phase budget.
     * Sent as a request header because a shared provider instance offers no other
     * per-call channel that reaches the custom `fetch`; fetch-timeout.ts strips it
     * before the request leaves, so no provider ever sees it.
     *
     * Deliberately applied HERE and not after the vision branch below: that branch
     * swaps in a different model and resets modelOptions, which correctly drops this
     * budget along with it. The timeout belongs to the model actually being called.
     */
    if (resolved.descriptor.headerTimeoutMs) {
      modelOptions = {
        ...modelOptions,
        headers: { [HEADER_TIMEOUT_HEADER]: String(resolved.descriptor.headerTimeoutMs) },
      };
    }

    if (image && !resolved.descriptor.supportsVision) {
      if (resolved.descriptor.provider === "nvidia") {
        model = getVisionModel();
        modelOptions = {};
        effectiveProviderModelId = getNvidiaVisionModelId();
      } else {
        return NextResponse.json(
          {
            error: `${resolved.descriptor.displayName} cannot read images. Switch to a model with vision support, or send your message without the attachment.`,
          },
          { status: 400 }
        );
      }
    }

    const activeMessage = image
      ? {
          role: "user" as const,
          content: [
            { type: "text" as const, text: plannedPrompt },
            // Decoded bytes, not a URL: the provider cannot be made to fetch anything.
            { type: "image" as const, image: image.data, mimeType: image.mediaType },
          ],
        }
      : { role: "user" as const, content: plannedPrompt };

    const startStream = (ctx: ReturnType<typeof buildContext>) =>
      streamText({
        model,
        system: ctx.systemPrompt,
        messages: [...ctx.messages, activeMessage] as never,
        maxTokens: resolved.effectiveOutputTokens,
        maxRetries: sdkRetriesFor(resolved.descriptor.provider),
        ...modelOptions,
        // The user's message is NOT written here — it is persisted before the stream
        // starts (see below). This callback writes the assistant side only.
        async onFinish({ text, usage }) {
          // Guarded because this runs after the reply has already been streamed to
          // the browser. An unguarded throw propagates into the AI SDK, which calls
          // controller.error() on a stream the user has already read: the reply
          // vanishes on reload, the stream breaks at the last moment, and nothing is
          // logged. Failing to record a turn must not also destroy it.
          try {
            const promptTokens = toTokenCount(usage?.promptTokens);
            const completionTokens = toTokenCount(usage?.completionTokens);

            // One transaction: an assistant reply with no updatedAt bump sorts to the
            // bottom of the sidebar, and a bump with no message under it shows an
            // empty conversation. Either half alone is a state the UI reads as
            // corruption, so they commit together or not at all.
            await prisma.$transaction([
              prisma.message.create({
                data: {
                  conversationId: activeConversationId,
                  role: "assistant",
                  content: text,
                  // Each message keeps the identity of the model that produced it, so a
                  // conversation can mix models without rewriting earlier turns.
                  provider: resolved.descriptor.provider,
                  model: effectiveProviderModelId,
                  // Persisted so the plan is still there after a reload.
                  plan: plan ? (plan as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
                  promptTokens,
                  completionTokens,
                },
              }),
              // Keep the sidebar's "most recent" ordering honest. updateMany so the
              // owner is part of the filter the database enforces.
              prisma.conversation.updateMany({
                where: { id: activeConversationId, userId },
                data: { updatedAt: new Date() },
              }),
              // Release the turn's idempotency key, in the SAME transaction that
              // records the reply. The key exists to guard an unresolved turn; once
              // the reply is durable the turn is resolved and the key must stop
              // blocking, or the user could never send that text again. Committing it
              // with the reply means the key is never released without a reply behind
              // it, and never held after one.
              prisma.message.update({
                where: { id: userMessageId },
                data: { idempotencyKey: null },
              }),
            ]);

            logger.debug("Turn persisted", {
              conversationId: activeConversationId,
              model: effectiveProviderModelId,
              // Null whenever the provider reported nothing; see toTokenCount.
              promptTokens,
              completionTokens,
            });

            // Started, deliberately not awaited.
            //
            // This is a second model call (up to 1024 tokens) that the user is not
            // waiting for. Awaiting it here held the stream open: the AI SDK does not
            // close its controller until onFinish resolves, and releaseOnStreamEnd
            // frees the user's generation slot only once the body drains. So a slow
            // summary kept a slot locked against concurrentGenerationLimit() long
            // after the reply was already on screen.
            //
            // Detaching is safe because CodeMind runs as a long-lived Node process
            // (Dockerfile CMD ["node","server.js"], render.yaml runtime: docker), so
            // work outliving a response still runs to completion. On a runtime that
            // freezes once the response is sent — any serverless platform — this
            // would silently stop summarizing and would need waitUntil() instead.
            void summarizeDropped(
              activeConversationId,
              userId,
              existingSummary,
              existingSummaryVersion,
              ctx.droppedMessagesContent
            ).catch((error) => {
              // summarizeDropped already swallows its own failures. This only stops a
              // future edit there turning a detached rejection into an unhandled one.
              logger.warn("Detached summarization rejected", {
                conversationId: activeConversationId,
                error: scrubForLog(error instanceof Error ? error.message : "unknown"),
              });
            });
          } catch (error) {
            // Logged and swallowed. Rethrowing would error the stream the user is
            // already reading, turning a bookkeeping failure into a visible one.
            logger.error("Failed to persist assistant turn", {
              conversationId: activeConversationId,
              error: scrubForLog(error instanceof Error ? error.message : "unknown"),
            });
          }
        },
      });

    // The user's own message is written BEFORE generation starts.
    //
    // It used to be written inside onFinish alongside the reply, so every failure
    // between here and a fully-read stream discarded it: the 503 no-capacity branch,
    // the 504 timeout, a context rejection that survives the bounded retry, and a
    // client disconnect mid-stream all return without onFinish ever running. The
    // user reloaded and their own prompt was simply gone.
    //
    // Deliberately placed here rather than immediately after validation: the artifact
    // branch above persists its own turn through persistTurn(), and writing earlier
    // would duplicate the user message on every artifact request. Everything between
    // validation and this line either persists the turn itself or rejects before any
    // generation was attempted.
    //
    // It carries the turn's idempotency key, and the unique index on that column is
    // what actually enforces "once". The lookup above is the fast path; this is the
    // race backstop for two identical requests that both got past it.
    let userMessageId: string;
    if (existingUserMessageId) {
      // Resuming an abandoned attempt: the message is already there. Writing it again
      // is precisely the duplicate this exists to prevent.
      userMessageId = existingUserMessageId;
    } else {
      try {
        const created = await prisma.message.create({
          data: {
            conversationId: activeConversationId,
            role: "user",
            content: originalRawContent,
            idempotencyKey: turnKey,
          },
          select: { id: true },
        });
        userMessageId = created.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Another request claimed this turn between our lookup and this insert, so it
        // is live by definition. Same answer as the in-flight branch above.
        logger.warn("Duplicate chat request lost the race for its turn key", {
          conversationId: activeConversationId,
        });
        return NextResponse.json(
          {
            error:
              "That message is already being processed. Wait a moment for the reply, or try again shortly.",
          },
          {
            status: 409,
            headers: { "Retry-After": "5", "x-conversation-id": activeConversationId },
          }
        );
      }
    }

    let result: Awaited<ReturnType<typeof startStream>>;
    try {
      result = await startStream(context);
    } catch (error) {
      // Every failure below carries x-conversation-id. The conversation and the user
      // message both exist by this point, and the client has no other way to learn
      // the id from an error: without it a retry from the dashboard names no
      // conversation and opens a second one. useChat reads the header, because
      // onResponse runs before it checks response.ok.
      if (isNoCapacityError(error)) {
        logger.warn("All provider keys busy", { conversationId: activeConversationId });
        return NextResponse.json(
          { error: "CodeMind is at capacity right now. Please try again in a moment." },
          {
            status: 503,
            headers: { "Retry-After": "5", "x-conversation-id": activeConversationId },
          }
        );
      }

      if (isProviderTimeoutError(error)) {
        logger.warn("Provider did not respond", {
          conversationId: activeConversationId,
          model: resolved.descriptor.id,
        });
        return NextResponse.json(
          {
            error: `${resolved.descriptor.displayName} did not respond. The model may be unavailable right now — try another model from the selector.`,
          },
          { status: 504, headers: { "x-conversation-id": activeConversationId } }
        );
      }
      if (!isProviderContextError(error)) throw error;

      // Exactly one bounded fallback: shrink the recent window to a single turn while
      // keeping the summary, the retrieved excerpts and the current request intact.
      // No retry loop.
      logger.warn("Provider rejected context; retrying once with a reduced window", {
        conversationId: activeConversationId,
      });

      context = buildContext(1);
      try {
        result = await startStream(context);
      } catch (retryError) {
        if (!isProviderContextError(retryError)) throw retryError;
        return NextResponse.json(
          {
            error:
              "This conversation is too large for the model's context window, even after reducing the history included. Please start a new conversation, or shorten your message.",
          },
          { status: 400, headers: { "x-conversation-id": activeConversationId } }
        );
      }
    }

    // Deterministic output guard. The system prompt forbids tool-call syntax, but a
    // prompt cannot guarantee it — three revisions of that prompt did not stop the
    // model inventing one. This drops it before it reaches the browser.
    // See lib/ai/chat-output-guard.ts.
    const streamed = guardChatStream(
      result.toDataStreamResponse({
        headers: { "x-conversation-id": activeConversationId },
      }),
      { conversationId: activeConversationId }
    );

    // The plan is written ahead of the model's own stream so the UI can render it
    // while generation is still running.
    const withPlan = plan
      ? createDataStreamPrefix(streamed, [{ codemindPlan: plan } as never])
      : streamed;

    // Released when the client finishes reading or the stream errors — and, failing
    // both, reclaimed by the timeout so the slot cannot leak.
    //
    // A DISCONNECT IS NOT A CANCELLATION. Navigating to another conversation used to
    // abort the provider request mid-sentence and persist an empty reply, losing a
    // turn the user had already paid for. `continueOnCancel` keeps the generation
    // running so onFinish still writes it, and it is waiting when they come back.
    slotHandedToStream = true;
    return releaseOnStreamEnd(withPlan, {
      onSettled: releaseSlot,
      continueOnCancel: true,
      timeoutMs: GENERATION_SLOT_MAX_LIFETIME_MS,
      onTimeout: () => {
        logger.warn("Reclaimed a generation slot from an abandoned chat stream", {
          conversationId: activeConversationId,
        });
        releaseSlot();
      },
    });
    } finally {
      // Frees the slot on every path that did NOT hand it to a stream: validation
      // failures, ownership rejections, context overflow, capacity 503s.
      releaseIfUnhanded();
    }
  } catch (error) {
    // The current request alone could not be made to fit. Explain it rather than
    // silently truncating what the user wrote.
    if (error instanceof ContextOverflowError) {
      logger.warn("Rejected: current message exceeds the context budget", {
        requiredTokens: error.requiredTokens,
        availableTokens: error.availableTokens,
      });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "";
    logger.error("Chat API error", { error: scrubForLog(message) });

    // A stalled provider that surfaced outside the streaming try/catch.
    if (isProviderTimeoutError(error)) {
      return NextResponse.json(
        {
          error:
            "The selected model did not respond. It may be unavailable right now — try another model from the selector.",
        },
        { status: 504 }
      );
    }

    // A provider context rejection is a user-actionable 400, never an opaque 500 —
    // and never leaks the provider's raw response.
    if (isProviderContextError(error)) {
      return NextResponse.json(
        {
          error:
            "This conversation is too large for the model's context window. Please start a new conversation, or shorten your message.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "An error occurred during chat processing" },
      { status: 500 }
    );
  }
}

interface ArtifactRequestParams {
  intent: "zip" | "pdf" | "file";
  promptText: string;
  /** Shown above the artifact card and persisted with the assistant message. */
  plan: ChatPlan | null;
  contextBlocks: string;
  conversationId: string;
  originalRawContent: string;
  existingSummary: string | null;
  /** Version read with the summary; the summary write is conditional on it. */
  existingSummaryVersion: number;
  droppedMessagesContent: string;
  /** Model the user selected, so artifacts come from their chosen model. */
  model: LanguageModelV1;
  provider: string;
  providerModelId: string;
  /** Slow-model header budget, carried from the descriptor. See GenerateArtifactOptions. */
  headerTimeoutMs?: number;
  /** The model's declared output ceiling, carried from the descriptor. */
  modelMaxOutputTokens: number;
  /** Owner of the conversation, from the session. Stamped onto the artifact. */
  userId: string;
}

const PHASE_LABELS: Record<string, string> = {
  zip: "Packaging ZIP…",
  pdf: "Rendering PDF…",
  file: "Writing file…",
};

/**
 * The artifact pipeline.
 *
 * Streams only user-readable progress and a short closing message. Generated source
 * never enters the stream, and the assistant message persisted to the database holds
 * the visible sentence alone — file contents live in the Artifact table.
 */
function handleArtifactRequest(params: ArtifactRequestParams): Response {
  const {
    intent,
    promptText,
    plan,
    contextBlocks,
    conversationId,
    originalRawContent,
    existingSummary,
    existingSummaryVersion,
    droppedMessagesContent,
    model,
    provider,
    providerModelId,
    headerTimeoutMs,
    modelMaxOutputTokens,
    userId,
  } = params;

  return createArtifactStreamResponse(
    async (writer) => {
      // Surface the plan immediately: the user sees the approach while generation runs.
      if (plan) writer.annotate({ codemindPlan: plan } as never);
      writer.progress("planning", "Planning the project…");
      writer.progress("generating", "Generating files…");

      const generation = await generateArtifact({
        type: intent,
        userPrompt: promptText,
        contextPrompt: contextBlocks || undefined,
        model,
        headerTimeoutMs,
        modelMaxOutputTokens,
      });

      if (!generation.ok) {
        writer.progress("failed", "Generation incomplete.");
        logger.warn("Artifact generation rejected", {
          conversationId,
          type: intent,
          errors: generation.errors,
          // Only set when VERIFICATION rejected it. Failures caught earlier have no
          // report, and logging an empty one would misattribute the cause. This is
          // also the only trace a rejected artifact leaves: no Artifact row is
          // written, so the verification column cannot measure failures.
          ...(generation.verification
            ? {
                failedChecks: generation.verification.checks
                  .filter((c) => c.status === "failed")
                  .map((c) => c.check),
                codes: generation.verification.errors.map((e) => e.code),
              }
            : {}),
        });

        const visible = [
          "No complete project artifact could be generated. Please retry.",
          "",
          `Reason: ${generation.errors[0]}`,
          "",
          "Narrowing the request (fewer files, or one part at a time) usually succeeds.",
        ].join("\n");

        await persistTurn(conversationId, userId, originalRawContent, visible, null, {
          provider,
          model: providerModelId,
          plan,
          // Recorded on the FAILURE path too, which is the entire point: without a row
          // here, rejected artifacts are invisible and every measurable rate is 100%.
          attempt: generation.verification
            ? attemptFromReport(generation.verification, intent, generation.generationMs)
            : {
                ok: false,
                stage: generation.stage,
                type: intent,
                warningCount: 0,
                // A failure's duration is how a fast rejection is told from a deadline:
                // the two can carry the same error string and mean opposite things.
                generationMs: generation.generationMs,
                version: 1,
              },
        });
        writer.text(visible);
        await summarizeDropped(conversationId, userId, existingSummary, existingSummaryVersion, droppedMessagesContent);
        return;
      }

      writer.progress("validating", "Validating project structure…");
      writer.progress("packaging", PHASE_LABELS[intent] ?? "Packaging…");

      // Package now, before showing a download button, so a failure here surfaces
      // as an error rather than a broken download later.
      //
      // Packaging can fail for reasons that have nothing to do with the model — a
      // missing font file, a disk problem. Without this guard the turn was lost
      // entirely: the user saw a raw exception in the stream and neither their
      // message nor any reply was written to the conversation.
      let body: Buffer;
      try {
        ({ body } = await buildArtifactBytes(generation.artifact));
      } catch (error) {
        writer.progress("failed", "Packaging failed.");
        logger.error("Artifact packaging failed", {
          conversationId,
          type: intent,
          error: error instanceof Error ? scrubForLog(error.message) : "unknown",
        });

        const visible = `Your ${intent.toUpperCase()} could not be packaged, so there is nothing to download. The content was generated correctly — this was a failure while building the file. Please try again.`;

        await persistTurn(conversationId, userId, originalRawContent, visible, null, {
          provider,
          model: providerModelId,
          plan,
          // A packaging failure is a real failed attempt even though the artifact was
          // valid. Counting it as a success because verification passed would hide the
          // one stage where a correct project still reaches nobody.
          attempt: {
            ok: false,
            stage: "packaging",
            type: intent,
            warningCount: 0,
            // The generation itself succeeded here — this duration is real and worth
            // keeping even though the turn failed later.
            generationMs: generation.generationMs,
            version: 1,
          },
        });
        writer.text(visible);
        await summarizeDropped(conversationId, userId, existingSummary, existingSummaryVersion, droppedMessagesContent);
        return;
      }

      /**
       * Warnings are shown, not swallowed.
       *
       * They do not block the download — a declared-but-unimported dependency is
       * normal in real projects — but a warning that exists only in a server log is
       * indistinguishable from one that was never raised. Composed once so the text
       * the user reads and the text persisted as the assistant message are the same
       * string; a reply that differed on reload would be its own small dishonesty.
       */
      const warningNote = describeWarnings(generation.verification);
      const visibleText = warningNote
        ? `${generation.summary}

${warningNote}`
        : generation.summary;

      if (generation.verification.warnings.length > 0) {
        logger.info("Artifact verified with warnings", {
          conversationId,
          type: intent,
          warnings: generation.verification.warnings.length,
          codes: generation.verification.warnings.map((w) => w.code),
        });
      }

      const record = await persistTurn(
        conversationId,
        userId,
        originalRawContent,
        visibleText,
        {
          artifact: generation.artifact,
          byteSize: body.byteLength,
          userId,
          verification: generation.verification,
        },
        {
          provider,
          model: providerModelId,
          plan,
          usage: generation.usage,
          attempt: {
            ok: true,
            stage: "persisted",
            type: intent,
            // Recorded so a later measurement can filter on it. A pass with coverage
            // "unchecked" and a pass with coverage "checked" are both ok:true, and
            // only this distinguishes them.
            coverage: generation.verification.coverage,
            warningCount: generation.verification.warnings.length,
            // The provider call ALONE. Durations for the rows written before this
            // existed had to be reconstructed from message timestamps, which bundles
            // validation, verification, packaging and two DB writes into the number.
            generationMs: generation.generationMs,
            version: 1,
          },
        }
      );

      writer.progress("ready", "Your download is ready.");
      writer.text(visibleText);

      if (record) {
        const metadata: ArtifactMetadata = {
          id: record.id,
          type: generation.artifact.type,
          filename: generation.artifact.filename,
          fileCount: generation.artifact.files.length,
          byteSize: body.byteLength,
        };
        writer.annotate({ codemindArtifacts: [metadata] } as never);
      }

      await summarizeDropped(conversationId, userId, existingSummary, existingSummaryVersion, droppedMessagesContent);
    },
    { headers: { "x-conversation-id": conversationId } }
  );
}

/**
 * Persist the user turn and the assistant's visible reply, plus any artifact.
 * `visibleText` is the only assistant content written to the database.
 */
async function persistTurn(
  conversationId: string,
  userId: string,
  userContent: string,
  visibleText: string,
  artifactData: {
    artifact: NormalizedArtifact;
    byteSize: number;
    userId: string;
    /**
     * Written so verification outcomes are measurable over time rather than only
     * observable in a log that rotates. Passed explicitly rather than defaulted:
     * a caller with no report must store null, which means "not checked", not
     * "checked and clean".
     */
    verification: VerificationReport;
  } | null,
  origin?: {
    provider: string;
    model: string;
    plan?: ChatPlan | null;
    /**
     * Outcome of an artifact attempt, written whether it succeeded or failed. This is
     * the only record a REJECTED artifact leaves, and the reason a success rate can be
     * computed at all — see Message.artifactAttempt.
     */
    attempt?: ArtifactAttempt;
    /**
     * Provider-reported usage for the generation that produced `visibleText`.
     * Null per field means not reported — never zero. Omitted entirely by callers
     * that had no generation to measure, such as a failure notice.
     */
    usage?: { promptTokens: number | null; completionTokens: number | null };
  }
): Promise<{ id: string } | null> {
  await prisma.message.create({
    data: { conversationId, role: "user", content: userContent },
  });

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: visibleText,
      provider: origin?.provider ?? null,
      model: origin?.model ?? null,
      plan: origin?.plan ? (origin.plan as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      // ?? null rather than a default: an absent `usage` and a reported zero must not
      // collapse into the same stored value.
      promptTokens: origin?.usage?.promptTokens ?? null,
      completionTokens: origin?.usage?.completionTokens ?? null,
      // Undefined for every non-artifact turn, which Prisma omits — leaving null, the
      // documented "this was not an artifact attempt".
      artifactAttempt: origin?.attempt
        ? (origin.attempt as unknown as Prisma.InputJsonValue)
        : undefined,
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conversationId, userId },
    data: { updatedAt: new Date() },
  });

  if (!artifactData) return null;

  const { artifact, byteSize, verification } = artifactData;
  const created = await prisma.artifact.create({
    data: {
      messageId: assistantMessage.id,
      // Stored directly so a download authorises against one indexed column instead
      // of walking Artifact -> Message -> Conversation on every request.
      userId,
      type: artifact.type,
      filename: artifact.filename,
      fileCount: artifact.files.length,
      byteSize,
      verification: verification as unknown as Prisma.InputJsonValue,
      // Internal representation — never returned to the browser.
      payload: {
        type: artifact.type,
        filename: artifact.filename,
        files: artifact.files,
        ...(artifact.markdown ? { markdown: artifact.markdown } : {}),
      } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return created;
}

/**
 * Rank the indexed files against a question and fetch the ones worth reading.
 *
 * The two halves are deliberately separate. Ranking and budgeting run against the
 * database alone, so a file is priced from its stored size before any request is
 * spent; only the survivors are downloaded. That is what keeps a shared GitHub budget
 * from being consumed by files that would have been dropped at packing time anyway.
 *
 * Every failure here is non-fatal. A repository that cannot be read should degrade to
 * an ordinary conversation — the model answering without the code is worse than
 * answering with it, but far better than the turn failing outright.
 */
/**
 * Per-turn repository coverage, in the same honest spirit as IndexCoverage.
 *
 * `graph` distinguishes four states that an absent neighbour cannot distinguish on
 * its own, and conflating them is what made the previous version unauditable:
 *   not-indexed     the snapshot predates import extraction, or its language is not
 *                   parsed. There are no edges and there never were.
 *   unavailable     edges exist but the query for them FAILED. Different from having
 *                   none, and the difference is a bug report rather than a fact.
 *   no-contribution edges were read and produced no candidate this turn.
 *   contributed     the graph put at least one file in front of the model.
 */
export type GraphCoverage = "not-indexed" | "unavailable" | "no-contribution" | "contributed";

/**
 * Which tier of entry-point detection produced a starting point.
 *
 * Reported rather than hidden because the tiers mean different things about the
 * repository: `conventional` is a layout everyone recognises, `structural` is a guess
 * from the import graph that nobody declared, and `none` means the fallback path had no
 * starting point at all and read files by depth.
 *
 * `manifest` is declared and NOT IMPLEMENTED — see the note at the detection site. It
 * exists in the type so the day it can be implemented is an addition rather than a
 * rename of stored values.
 */
export type EntryPointTier = "manifest" | "conventional" | "structural" | "none";

export interface RepositorySelection {
  files: Array<{ path: string; content: string }>;
  graph: GraphCoverage;
  /** Files chosen that came from the graph rather than from matching. */
  graphFiles: number;
  /**
   * The repository index itself could not be read.
   *
   * NOT the same as selecting zero files: an empty selection means the repository was
   * consulted and nothing was worth reading, while this means it was never consulted.
   * The caller must tell the model, because a model answering with neither the files
   * nor the knowledge that files are missing sounds exactly as confident either way.
   */
  loadFailed: boolean;
}

async function loadRepositoryFiles(params: {
  repository: {
    id: string;
    owner: string;
    name: string;
    commitSha: string;
    entryPoints: string[];
    importsExtracted: boolean;
  };
  question: string;
  contextTokens: number;
}): Promise<RepositorySelection> {
  const { repository, question, contextTokens } = params;

  try {
    const indexed = await prisma.repositoryFile.findMany({
      where: {
        repositoryId: repository.id,
        // Only files with a recognised source extension are candidates. Lockfiles and
        // binaries are still indexed so the file list stays honest, but reading one
        // spends a request and a large share of the budget to tell the model nothing.
        NOT: { language: null },
      },
      // symbols is what lets a question about behaviour — "how does it decide whether
      // a value is a plain object" — reach the file that implements it. Omitting it
      // here would silently leave scoring path-only in production while every unit
      // test still passed, because the tests supply symbols directly.
      // `id` is here only to translate edge endpoints back into paths below. Selection
      // itself stays path-based: it must remain testable without a database.
      select: {
        id: true,
        path: true,
        size: true,
        language: true,
        symbols: true,
        internalSymbols: true,
      },
      take: REPOSITORY_SELECTION_SCAN_LIMIT,
    });

    /**
     * Every empty result below is reported at warn level.
     *
     * A turn that reaches here has a repository attached and READY, so the user is
     * asking about code and expecting the code to be in view. Returning nothing means
     * the model answers from the conversation alone and sounds exactly as confident as
     * it would with the files — the failure is invisible in the reply. Until this
     * existed the only way to investigate "the AI ignored my repo" was SQL against
     * RepositoryFile, because the one warn on this path fires on a thrown error and
     * none of these four exits throws.
     *
     * The `reason` distinguishes them, since they need completely different fixes:
     * an index with no source files is an ingestion problem, nothing scoring is a
     * selection problem, nothing fitting is a budget problem, and every fetch failing
     * is a GitHub problem.
     */
    const empty = (
      reason: string,
      counts: { candidates: number; scored: number; chosen: number; fetched: number },
      graph: GraphCoverage = "not-indexed"
    ): RepositorySelection => {
      logger.warn("Repository attached but no files reached the model", {
        repositoryId: repository.id,
        reason,
        // Scrubbed and truncated: a question is user content, and it is here only to
        // make the failure reproducible.
        query: scrubForLog(question).slice(0, REPOSITORY_QUERY_LOG_CHARS),
        ...counts,
      });
      // An empty selection, not a failed one. The repository WAS read; nothing in it
      // was worth putting in front of the model this turn.
      return { files: [], graph, graphFiles: 0, loadFailed: false };
    };

    if (indexed.length === 0) {
      return empty("index_has_no_source_files", { candidates: 0, scored: 0, chosen: 0, fetched: 0 });
    }

    /**
     * A question about behaviour rather than filenames scores nothing — the ceiling of
     * path-only selection, measured rather than assumed. See fallbackFiles for the
     * case that demonstrates it and why entry points are the honest answer until a
     * symbol index exists.
     */
    const scored = scoreFiles(indexed, question);

    /**
     * Resolved import edges for the files expansion will start from.
     *
     * Queried after scoring and only for the seeds, not loaded wholesale: FileEdge is
     * indexed on (repositoryId, sourceFileId) and (repositoryId, targetFileId) so this
     * is two index lookups against a handful of ids rather than a scan of every edge.
     *
     * Skipped entirely when no graph exists — a snapshot indexed before edges, or a
     * language whose imports are not parsed. That is `importsExtracted`, carried from
     * the repository row rather than inferred from an empty result, because "no edges"
     * and "never parsed" are different facts and only one of them is worth a query.
     *
     * The seeds differ by path, and so does what the edges are FOR:
     *   - scoring matched  -> the top matches, widened to the code they sit next to;
     *   - scoring matched nothing -> the entry points, whose imports beat the
     *     depth-ordered guess that fallbackFiles would otherwise fall through to.
     */
    /**
     * Entry points, re-detected at query time rather than read from stored structure.
     *
     * TIER 1 (manifest-declared) IS NOT IMPLEMENTED, and the reason is a hard
     * constraint rather than a choice: package.json CONTENT is nowhere available here.
     * RepositoryFile stores path, blobSha, size, language and symbols — no content —
     * and detectStructure sees only tree entries, so it records manifest PATHS and
     * never their bodies. Reading `main`/`module`/`exports`/`bin` would therefore cost
     * one GitHub request per turn on top of the three files already fetched, breaking
     * the per-turn fetch bound. Capturing it during ingestion is the right fix and is a
     * different change.
     *
     * Re-detecting here rather than trusting `repository.entryPoints` is what lets an
     * index built before the widening benefit from it. ky was indexed with a list that
     * had `src/index.ts` and not `source/index.ts`, and stored an empty array.
     */
    let entryPoints = repository.entryPoints;
    let entryTier: EntryPointTier = entryPoints.length > 0 ? "conventional" : "none";

    if (entryPoints.length === 0) {
      const widened = detectEntryPoints(new Set(indexed.map((f) => f.path)));
      if (widened.length > 0) {
        entryPoints = widened;
        entryTier = "conventional";
      }
    }

    let links: Array<{ fromPath: string; toPath: string }> = [];
    /**
     * Starts as not-indexed: with importsExtracted false there are no edges and never
     * were, which is a fact about the snapshot rather than a failure this turn.
     */
    let graph: GraphCoverage = repository.importsExtracted ? "no-contribution" : "not-indexed";

    if (repository.importsExtracted) {
      const idByPath = new Map(indexed.map((f) => [f.path, f.id]));
      const pathById = new Map(indexed.map((f) => [f.id, f.path]));

      /**
       * TIER 3: no declaration, no convention — ask the graph.
       *
       * Only on the fallback path, and only when nothing else found a starting point.
       * One aggregate query, not a file fetch, so the per-turn fetch bound is untouched.
       */
      if (scored.length === 0 && entryPoints.length === 0) {
        try {
          const rows = await prisma.fileEdge.findMany({
            where: { repositoryId: repository.id, kind: "resolved" },
            select: { sourceFileId: true, targetFileId: true },
            take: REPOSITORY_EDGE_SCAN_LIMIT,
          });
          const pathOf = new Map(indexed.map((f) => [f.id, f.path]));
          const all = rows.flatMap((r) => {
            const fromPath = pathOf.get(r.sourceFileId);
            const toPath = r.targetFileId ? pathOf.get(r.targetFileId) : undefined;
            return fromPath && toPath ? [{ fromPath, toPath }] : [];
          });

          // Ranked by hubFiles rather than by the database. A groupBy would count just
          // as well but orders ties arbitrarily, and an entry point that changed
          // between identical turns would make a wrong answer unreproducible.
          const detected = hubFiles(indexed, all, REPOSITORY_EDGE_SEEDS);
          if (detected.length > 0) {
            entryPoints = detected;
            entryTier = "structural";
          }
        } catch (error) {
          // Same posture as the edge query below: an optional detection tier failing
          // must not cost the turn its files.
          logger.warn("Structural entry-point detection unavailable", {
            repositoryId: repository.id,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }

      const seedPaths =
        scored.length > 0
          ? scored.slice(0, REPOSITORY_EDGE_SEEDS).map((f) => f.path)
          : entryPoints.slice(0, REPOSITORY_EDGE_SEEDS);

      const seedIds = seedPaths
        .map((path) => idByPath.get(path))
        .filter((id): id is string => typeof id === "string");

      if (seedIds.length > 0) {
        try {
        const edgeRows = await prisma.fileEdge.findMany({
          where: {
            repositoryId: repository.id,
            kind: "resolved",
            OR: [{ sourceFileId: { in: seedIds } }, { targetFileId: { in: seedIds } }],
          },
          select: { sourceFileId: true, targetFileId: true },
          take: REPOSITORY_EDGE_SCAN_LIMIT,
        });

        links = edgeRows.flatMap((row) => {
          const fromPath = pathById.get(row.sourceFileId);
          const toPath = row.targetFileId ? pathById.get(row.targetFileId) : undefined;
          // An endpoint outside the loaded set — past the scan limit, or a file with no
          // recognised source extension. Dropped, because expansion may only reach files
          // that were candidates in the first place.
          if (!fromPath || !toPath) return [];
          return [{ fromPath, toPath }];
        });
        } catch (error) {
          /**
           * A failed edge query is a PARTIAL failure and must not take the turn with
           * it. Scored files are already in hand and are the larger part of the value;
           * losing them because an optional widening step broke would be the same
           * silent-blindness failure this whole change exists to remove.
           *
           * Recorded as `unavailable` rather than left looking like "no edges": one is
           * a fact about the repository, the other is a bug report.
           */
          graph = "unavailable";
          links = [];
          logger.warn("Import graph unavailable for this turn", {
            repositoryId: repository.id,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }
    }

    /**
     * A question about behaviour rather than filenames scores nothing — the ceiling of
     * path-only selection, measured rather than assumed. See fallbackFiles for the
     * case that demonstrates it and why entry points are the honest answer until a
     * symbol index exists.
     */
    const candidates =
      scored.length > 0
        ? expandAlongEdges(scored, indexed, links, MAX_REPOSITORY_FILES_PER_TURN)
        : fallbackFiles(indexed, entryPoints, MAX_REPOSITORY_FILES_PER_TURN, links);



    // Currently unreachable, and deliberately checked anyway: fallbackFiles(indexed, ...)
    // cannot return empty while `indexed` is non-empty — with no entry points matched it
    // falls through to "remaining files by depth", which is `indexed` itself. Verified,
    // not assumed. Kept as a guard against that contract changing rather than removed,
    // since a silent assumption is exactly the failure class this change exists to close.
    if (candidates.length === 0) {
      return empty("no_candidates_after_fallback", {
        candidates: indexed.length,
        scored: scored.length,
        chosen: 0,
        fetched: 0,
      });
    }

    const allowance = Math.floor(contextTokens * REPOSITORY_FETCH_ALLOWANCE_RATIO);
    const chosen = selectWithinBudget(candidates, allowance, MAX_REPOSITORY_FILES_PER_TURN);
    if (chosen.length === 0) {
      return empty("none_fit_token_budget", {
        candidates: indexed.length,
        scored: scored.length,
        chosen: 0,
        fetched: 0,
      });
    }

    const ref = { owner: repository.owner, name: repository.name };
    const files: Array<{ path: string; content: string }> = [];

    for (const file of chosen) {
      try {
        const content = await fetchFileContent(ref, repository.commitSha, file.path);
        files.push({ path: file.path, content });
      } catch (error) {
        // One unreadable file must not lose the others already fetched.
        logger.warn("Could not read a repository file", {
          path: file.path,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    // Counted from what was actually FETCHED, not from what was chosen: a graph file
    // that failed to download did not reach the model, and reporting it as a
    // contribution would overstate the feature every time GitHub hiccups.
    const graphPaths = new Set(chosen.filter((c) => c.viaGraph === true).map((c) => c.path));
    const chosenFromGraph = files.filter((f) => graphPaths.has(f.path)).length;
    if (graph !== "unavailable" && graph !== "not-indexed") {
      graph = chosenFromGraph > 0 ? "contributed" : "no-contribution";
    }

    logger.debug("Repository files selected", {
      repositoryId: repository.id,
      candidates: indexed.length,
      scored: scored.length,
      usedFallback: scored.length === 0,
      // One field, four distinguishable states — see GraphCoverage. Previously a turn
      // with a broken edge query and a turn against a repository that has no edges
      // logged identically.
      graph,
      // Which tier produced a starting point. "none" means the fallback path had none
      // and read by depth — diagnostic, not an implementation detail.
      entryTier,
      entryPoints: entryPoints.length,
      importsExtracted: repository.importsExtracted,
      edgesConsidered: links.length,
      addedByGraph: candidates.filter((c) => c.viaGraph === true).length,
      chosenFromGraph,
      fetched: files.length,
    });

    return files.length > 0
      ? { files, graph, graphFiles: chosenFromGraph, loadFailed: false }
      : empty(
          "all_file_fetches_failed",
          {
            candidates: indexed.length,
            scored: scored.length,
            chosen: chosen.length,
            fetched: 0,
          },
          graph
        );
  } catch (error) {
    /**
     * TOTAL failure: the index could not be read at all.
     *
     * This used to return undefined, which the caller could not tell apart from "the
     * repository had nothing worth reading". The model then answered from the
     * conversation alone, in the same confident voice it would have used with the
     * files — the system was blind and did not say so. `loadFailed` is what the caller
     * turns into a sentence the model must repeat.
     */
    logger.warn("Repository file selection failed", {
      repositoryId: repository.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return { files: [], graph: "not-indexed", graphFiles: 0, loadFailed: true };
  }
}
