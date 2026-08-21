import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Artifacts generated inside a project.
 *
 * Reuses the existing Artifact table and the existing download endpoint — there is no
 * project-specific storage. Only metadata is returned; `payload` holds the file
 * contents and is never selected, exactly as in the conversation detail route.
 */

const MAX_ARTIFACTS = 200;

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

    const project = await prisma.project.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const rows = await prisma.artifact.findMany({
      where: {
        userId,
        message: { conversation: { projectId: project.id, userId } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ARTIFACTS,
      select: {
        id: true,
        type: true,
        filename: true,
        fileCount: true,
        byteSize: true,
        createdAt: true,
        message: {
          select: { conversation: { select: { id: true, title: true } } },
        },
      },
    });

    return NextResponse.json({
      artifacts: rows.map((row) => ({
        id: row.id,
        type: row.type,
        filename: row.filename,
        fileCount: row.fileCount,
        byteSize: row.byteSize,
        createdAt: row.createdAt,
        conversationId: row.message.conversation.id,
        conversationTitle: row.message.conversation.title,
      })),
    });
  } catch (error) {
    logger.error("Failed to list project artifacts", {
      projectId: params.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to load files" }, { status: 500 });
  }
}
