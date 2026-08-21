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
