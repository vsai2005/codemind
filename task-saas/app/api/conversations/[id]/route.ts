import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { enforceBodyLimit } from "@/lib/http/body-limit";
import { isGenerationPending } from "@/lib/ai/generation-window";

/**
 * Conversation detail.
 *
 * Artifacts are returned as metadata only. The `payload` column holds full file
 * contents and is deliberately excluded from the select so it can never reach the
 * browser.
 *
 * `pendingSince` tells the client a reply is still being written. It matters because a
 * generation SURVIVES the reader leaving — switching conversations detaches the stream
 * rather than killing it (see lib/ai/stream-lifecycle.ts) — so coming back to a
 * conversation mid-answer must not look like nothing is happening. Without this the
 * page loads the history once, finds no reply, and shows a dead conversation until the
 * user reloads by hand.
 */

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.id, userId: session.user.id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            artifacts: {
              select: {
                id: true,
                type: true,
                filename: true,
                fileCount: true,
                byteSize: true,
              },
            },
          },
        },
      },
    });

    if (!conversation) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    // Derived, not stored: the user's message is written before generation begins, so
    // a trailing user turn IS the in-flight state. See generation-window.ts for why
    // this is bounded rather than open-ended.
    const last = conversation.messages[conversation.messages.length - 1] ?? null;
    const pending = isGenerationPending(last?.role ?? null, last?.createdAt ?? null);

    return NextResponse.json({
      ...conversation,
      pendingSince: pending ? last!.createdAt.toISOString() : null,
    });
  } catch (error) {
    logger.error("Failed to fetch conversation", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to fetch conversation" }, { status: 500 });
  }
}

const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    /**
     * Move between workspaces. `null` makes it a personal chat; a project id moves it
     * into that project — but only if the caller owns that project too (checked below).
     */
    projectId: z.string().min(1).max(64).nullable().optional(),
    /** true archives, false restores. Archiving never deletes anything. */
    archived: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined || data.projectId !== undefined || data.archived !== undefined,
    { message: "provide a title, a projectId, or archived" }
  );

/** Rename a conversation, or move it between a project and personal chats. */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let raw: unknown;
    try {
      const oversized = enforceBodyLimit(req, "json");
      if (oversized) return oversized;
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsed = updateConversationSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const data: { title?: string; projectId?: string | null; archivedAt?: Date | null } = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.archived !== undefined) {
      // Archiving is presentation-only: messages and artifacts are untouched.
      data.archivedAt = parsed.data.archived ? new Date() : null;
    }

    if (parsed.data.projectId !== undefined) {
      if (parsed.data.projectId === null) {
        data.projectId = null;
      } else {
        // The destination project must belong to the caller too. Without this check a
        // user could file their own conversation into someone else's workspace.
        const destination = await prisma.project.findFirst({
          where: { id: parsed.data.projectId, userId },
          select: { id: true },
        });
        if (!destination) {
          return NextResponse.json({ error: "Not Found" }, { status: 404 });
        }
        data.projectId = destination.id;
      }
    }

    // Ownership enforced by the update filter itself.
    const result = await prisma.conversation.updateMany({
      where: { id: params.id, userId },
      data,
    });

    if (result.count === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: params.id, userId },
      select: { id: true, title: true, projectId: true, archivedAt: true, updatedAt: true },
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    logger.error("Failed to update conversation", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to update conversation" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Ownership is enforced in the delete filter itself.
    const result = await prisma.conversation.deleteMany({
      where: { id: params.id, userId: session.user.id },
    });

    if (result.count === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete conversation", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to delete conversation" }, { status: 500 });
  }
}
