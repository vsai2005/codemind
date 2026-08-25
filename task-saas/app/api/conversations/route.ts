import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Same contract as GET /api/projects: archived conversations are hidden from the
    // default listing but never deleted; pass ?archived=1 to see them.
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";

    const conversations = await prisma.conversation.findMany({
      where: {
        userId: session.user.id,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json(conversations);
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch conversations" }, { status: 500 });
  }
}
