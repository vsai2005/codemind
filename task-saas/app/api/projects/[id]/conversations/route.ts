import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Conversations belonging to a project.
 *
 * Doubly scoped: the project must belong to the caller AND the conversations are
 * filtered by the same userId. Either predicate alone would be sufficient today, but
 * both together mean a future change to one cannot silently open the other.
 */

const MAX_CONVERSATIONS = 200;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Prove ownership of the project before listing anything inside it.
    const project = await prisma.project.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const rows = await prisma.conversation.findMany({
      where: { projectId: project.id, userId },
      orderBy: { updatedAt: "desc" },
      take: MAX_CONVERSATIONS,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });

    return NextResponse.json({
      conversations: rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messageCount: row._count.messages,
      })),
    });
  } catch (error) {
    logger.error("Failed to list project conversations", {
      projectId: params.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to load conversations" }, { status: 500 });
  }
}
