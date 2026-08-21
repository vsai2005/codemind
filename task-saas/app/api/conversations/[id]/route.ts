import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

/**
 * Conversation detail.
 *
 * Artifacts are returned as metadata only. The `payload` column holds full file
 * contents and is deliberately excluded from the select so it can never reach the
 * browser.
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

    return NextResponse.json(conversation);
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
  })
  .refine((data) => data.title !== undefined || data.projectId !== undefined, {
    message: "provide a title or a projectId",
  });

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
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsed = updateConversationSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const data: { title?: string; projectId?: string | null } = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;

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
      select: { id: true, title: true, projectId: true, updatedAt: true },
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
