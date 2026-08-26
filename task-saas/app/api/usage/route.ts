import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Lifetime token usage for the signed-in user.
 *
 * AGGREGATED IN THE DATABASE, never in application code. A user with thousands of
 * messages must not have them loaded to be counted — `_sum` is one indexed pass and
 * returns three numbers regardless of how many rows it covers.
 *
 * Ownership is a property of the query: messages are reached through their
 * conversation's `userId`, so nothing the client sends can widen the scope.
 *
 * VISIBILITY ONLY. These are counts the providers reported, not spend. No pricing is
 * applied here and none should be — a token count is a fact, a cost is a claim about
 * a rate card that changes without notice.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const mine = { conversation: { userId } };

    // Batched so the totals and the unreported count describe the same instant.
    const [totals, reported, unreported] = await prisma.$transaction([
      prisma.message.aggregate({
        where: mine,
        _sum: { promptTokens: true, completionTokens: true },
      }),
      prisma.message.count({ where: { ...mine, promptTokens: { not: null } } }),
      // Assistant turns the provider never reported usage for. Counted rather than
      // estimated: Gemini reports nothing at all, so a conversation held there would
      // otherwise read as near-zero usage instead of unmeasured.
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
        /** Assistant turns that DID report, so the totals above have a denominator. */
        reportedMessages: reported,
        /** Assistant turns with no usage from the provider. Never counted as zero. */
        unreportedMessages: unreported,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    logger.error("Failed to aggregate usage", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
  }
}
