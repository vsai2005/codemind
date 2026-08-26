import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Token usage for one conversation.
 *
 * Separate from GET /api/conversations/[id] on purpose. That route returns every
 * message, and the chat view hands those to `useChat`, which then owns the list —
 * messages that arrive by streaming never carry these columns, so a total computed in
 * the browser would drift downward with every turn the user actually sent. Asking the
 * database keeps the readout describing what was stored rather than what the client
 * happens to be holding.
 *
 * Aggregated in the database for the same reason as the profile total: a long
 * conversation must not be loaded to be counted.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Ownership enforced by the filter itself — a conversation belonging to someone
    // else simply matches nothing, and reports zero rather than confirming it exists.
    const mine = { conversationId: params.id, conversation: { userId: session.user.id } };

    const [totals, unreported] = await prisma.$transaction([
      prisma.message.aggregate({
        where: mine,
        _sum: { promptTokens: true, completionTokens: true },
      }),
      prisma.message.count({
        where: { ...mine, role: "assistant", promptTokens: null },
      }),
    ]);

    const promptTokens = totals._sum.promptTokens ?? 0;
    const completionTokens = totals._sum.completionTokens ?? 0;

    return NextResponse.json(
      {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        /**
         * Turns the provider gave no usage for. Surfaced rather than folded in: null
         * means "not reported", and adding an estimate to a measured total would make
         * the sum unverifiable against the provider's own numbers.
         */
        unreportedMessages: unreported,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    logger.error("Failed to aggregate conversation usage", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
  }
}
