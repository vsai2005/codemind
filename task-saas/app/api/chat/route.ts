import { streamText, generateText, type LanguageModelV1 } from "ai";
import { NextResponse } from "next/server";
import { getVisionModel, nemotronOptions, NO_CAPACITY_CODE } from "@/lib/ai/gateway";
import { getDefaultModelId, getNvidiaVisionModelId, resolveModel } from "@/lib/ai/models/registry";
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
import { createArtifactStreamResponse } from "@/lib/artifacts/stream";
import { buildArtifactBytes } from "@/lib/artifacts/build";
import { enforceRateLimit, acquireGenerationSlot, concurrentGenerationLimit } from "@/lib/rate-limit";
import { scrubForLog } from "@/lib/ai/failure-classification";
import { releaseOnStreamEnd } from "@/lib/ai/stream-lifecycle";
import { buildPlan, planToPromptBlock, type ChatPlan } from "@/lib/ai/planning";
import { createDataStreamPrefix } from "@/lib/ai/plan-stream";
import { logger } from "@/lib/logger";
// Prisma is used as a value here (Prisma.DbNull), not only as a type.
import { Prisma } from "@prisma/client";
import type { ArtifactMetadata, NormalizedArtifact } from "@/lib/artifacts/types";
import { enforceBodyLimit } from "@/lib/http/body-limit";

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
 * The gateway already performs bounded failover across API keys, so the AI SDK's own
 * retry is switched off. Leaving it at its default of 2 would multiply against the
 * gateway's attempts and fire up to nine upstream calls for a single turn.
 */
const SDK_RETRIES = 0;

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
  droppedMessagesContent: string
): Promise<void> {
  if (!droppedMessagesContent) return;

  try {
    const summaryResult = await generateText({
      // Conversation memory is model-neutral: one summary serves whichever model the
      // user has selected. Using the selected model here would make the summary's
      // character depend on who happened to be answering when it was written.
      model: resolveModel(process.env.CODEMIND_SUMMARY_MODEL || getDefaultModelId()).model,
      maxRetries: SDK_RETRIES,
      prompt: `You are a conversation memory manager.
Summarize the following old conversation messages. Extract key decisions, architecture rules, project goals, and constraints. Do NOT include large code snippets.
Merge this effectively with the existing summary if one exists.

Existing Summary:
${existingSummary || "None"}

Old Messages to add to memory:
${droppedMessagesContent}
`,
      maxTokens: 1024,
    });

    // updateMany so ownership is part of the filter the database enforces, matching
    // every other write in the app. The id is server-derived and already checked, so
    // this is defence in depth rather than a fix for a reachable hole.
    await prisma.conversation.updateMany({
      where: { id: conversationId, userId },
      data: { summary: summaryResult.text.trim() },
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

    // Ownership is always derived from the session, never from the request body.
    let activeConversationId: string;
    let existingSummary: string | null = null;

    let activeProjectId: string | null = null;

    if (!conversationId) {
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
        where: { id: conversationId, userId },
      });
      if (!existing) {
        return NextResponse.json(
          { error: "Conversation not found or unauthorized" },
          { status: 404 }
        );
      }
      activeConversationId = existing.id;
      existingSummary = existing.summary;
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

    if (activeProjectId) {
      const project = await prisma.project.findFirst({
        where: { id: activeProjectId, userId },
        select: { instructions: true, memory: true },
      });
      if (project) {
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
        droppedMessagesContent: context.droppedMessagesContent,
        model: resolved.model,
        provider: resolved.descriptor.provider,
        providerModelId: resolved.descriptor.providerModelId,
        userId,
      });

      // The generation outlives this function, so the slot travels with the stream.
      slotHandedToStream = true;
      return releaseOnStreamEnd(artifactResponse, { onSettled: releaseSlot });
    }

    // Vision compatibility. Three distinct cases, none of which silently drops the image:
    //   - the selected model sees images natively -> use it directly;
    //   - it does not, but it is NVIDIA -> route to the existing NVIDIA vision model,
    //     preserving the behaviour that shipped before multi-model support;
    //   - it does not, and no vision path exists for that provider -> say so plainly.
    let model = resolved.model;
    let modelOptions: Record<string, unknown> = resolved.descriptor.provider === "nvidia" ? nemotronOptions : {};
    let effectiveProviderModelId = resolved.descriptor.providerModelId;

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
        maxRetries: SDK_RETRIES,
        ...modelOptions,
        async onFinish({ text }) {
          await prisma.message.create({
            data: { conversationId: activeConversationId, role: "user", content: originalRawContent },
          });
          await prisma.message.create({
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
            },
          });
          // Keep the sidebar's "most recent" ordering honest. updateMany so the
          // owner is part of the filter the database enforces.
          await prisma.conversation.updateMany({
            where: { id: activeConversationId, userId },
            data: { updatedAt: new Date() },
          });

          await summarizeDropped(activeConversationId, userId, existingSummary, ctx.droppedMessagesContent);
        },
      });

    let result: Awaited<ReturnType<typeof startStream>>;
    try {
      result = await startStream(context);
    } catch (error) {
      if (isNoCapacityError(error)) {
        logger.warn("All provider keys busy", { conversationId: activeConversationId });
        return NextResponse.json(
          { error: "CodeMind is at capacity right now. Please try again in a moment." },
          { status: 503, headers: { "Retry-After": "5" } }
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
          { status: 504 }
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
          { status: 400 }
        );
      }
    }

    const streamed = result.toDataStreamResponse({
      headers: { "x-conversation-id": activeConversationId },
    });

    // The plan is written ahead of the model's own stream so the UI can render it
    // while generation is still running.
    const withPlan = plan
      ? createDataStreamPrefix(streamed, [{ codemindPlan: plan } as never])
      : streamed;

    // Released when the client finishes reading, disconnects, or the stream errors.
    slotHandedToStream = true;
    return releaseOnStreamEnd(withPlan, { onSettled: releaseSlot });
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
  droppedMessagesContent: string;
  /** Model the user selected, so artifacts come from their chosen model. */
  model: LanguageModelV1;
  provider: string;
  providerModelId: string;
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
    droppedMessagesContent,
    model,
    provider,
    providerModelId,
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
      });

      if (!generation.ok) {
        writer.progress("failed", "Generation incomplete.");
        logger.warn("Artifact generation rejected", {
          conversationId,
          type: intent,
          errors: generation.errors,
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
        });
        writer.text(visible);
        await summarizeDropped(conversationId, userId, existingSummary, droppedMessagesContent);
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
        });
        writer.text(visible);
        await summarizeDropped(conversationId, userId, existingSummary, droppedMessagesContent);
        return;
      }

      const record = await persistTurn(
        conversationId,
        userId,
        originalRawContent,
        generation.summary,
        { artifact: generation.artifact, byteSize: body.byteLength, userId },
        { provider, model: providerModelId, plan }
      );

      writer.progress("ready", "Your download is ready.");
      writer.text(generation.summary);

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

      await summarizeDropped(conversationId, userId, existingSummary, droppedMessagesContent);
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
  artifactData: { artifact: NormalizedArtifact; byteSize: number; userId: string } | null,
  origin?: { provider: string; model: string; plan?: ChatPlan | null }
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
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conversationId, userId },
    data: { updatedAt: new Date() },
  });

  if (!artifactData) return null;

  const { artifact, byteSize } = artifactData;
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
