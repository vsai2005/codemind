import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Token usage bucketed over time, for the usage view in settings.
 *
 * THREE WINDOWS, THREE BUCKET SIZES
 *   5h      twelve 5-hour blocks, covering 60 hours
 *   week    seven daily buckets
 *   month   thirty daily buckets
 *
 * BUCKETED IN POSTGRES, NOT IN JAVASCRIPT. The obvious implementation reads every
 * message and groups them in a loop, which is fine at 40 messages and ruinous at
 * 40,000 — the same reason the lifetime total uses `_sum`. `date_trunc` plus an
 * interval floor does the grouping where the rows already live, so the response size
 * depends on the number of BUCKETS (at most 30) rather than the number of messages.
 *
 * WHY 5-HOUR BLOCKS ARE FLOORED AGAINST AN EPOCH rather than counted back from now:
 * a block has to mean the same span every time it is read, or the same message would
 * move between buckets depending on when you looked, and a bar chart that reshuffles
 * on refresh is worse than no chart. Flooring to a fixed grid makes the boundaries
 * stable, which is also what "it resets" means to a reader.
 */

type Window = "5h" | "week" | "month";

interface BucketRow {
  bucket: Date;
  total: bigint | number | null;
}

const WINDOWS: Record<Window, { buckets: number; sql: (userId: string) => Promise<BucketRow[]> }> = {
  /** Twelve 5-hour blocks. to_timestamp(floor(epoch/18000)*18000) is the block start. */
  "5h": {
    buckets: 12,
    sql: (userId) => prisma.$queryRaw<BucketRow[]>`
      SELECT to_timestamp(floor(extract(epoch FROM m."createdAt") / 18000) * 18000) AS bucket,
             SUM(COALESCE(m."promptTokens", 0) + COALESCE(m."completionTokens", 0)) AS total
      FROM "Message" m
      JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."userId" = ${userId}
        AND m."createdAt" >= NOW() - INTERVAL '60 hours'
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
  },
  week: {
    buckets: 7,
    sql: (userId) => prisma.$queryRaw<BucketRow[]>`
      SELECT date_trunc('day', m."createdAt") AS bucket,
             SUM(COALESCE(m."promptTokens", 0) + COALESCE(m."completionTokens", 0)) AS total
      FROM "Message" m
      JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."userId" = ${userId}
        AND m."createdAt" >= NOW() - INTERVAL '7 days'
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
  },
  month: {
    buckets: 30,
    sql: (userId) => prisma.$queryRaw<BucketRow[]>`
      SELECT date_trunc('day', m."createdAt") AS bucket,
             SUM(COALESCE(m."promptTokens", 0) + COALESCE(m."completionTokens", 0)) AS total
      FROM "Message" m
      JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."userId" = ${userId}
        AND m."createdAt" >= NOW() - INTERVAL '30 days'
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
  },
};

const BUCKET_MS: Record<Window, number> = {
  "5h": 5 * 60 * 60 * 1000,
  week: 24 * 60 * 60 * 1000,
  month: 24 * 60 * 60 * 1000,
};

/** Floor a timestamp onto the same grid the SQL uses, so client and server agree. */
function floorTo(ms: number, size: number): number {
  return Math.floor(ms / size) * size;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const raw = new URL(request.url).searchParams.get("window");
    const windowKey: Window = raw === "week" || raw === "month" ? raw : "5h";
    const spec = WINDOWS[windowKey];
    const size = BUCKET_MS[windowKey];

    const rows = await spec.sql(userId);

    // Rows only exist where there was activity. The chart needs every bucket, so the
    // gaps are filled with zero — a missing bar and an idle bar look the same to a
    // reader, and only one of them is honest about the axis being continuous.
    const byBucket = new Map<number, number>();
    for (const row of rows) {
      const at = floorTo(new Date(row.bucket).getTime(), size);
      byBucket.set(at, Number(row.total ?? 0));
    }

    const nowFloor = floorTo(Date.now(), size);
    const series: Array<{ startsAt: string; tokens: number; isCurrent: boolean }> = [];
    for (let i = spec.buckets - 1; i >= 0; i--) {
      const at = nowFloor - i * size;
      series.push({
        startsAt: new Date(at).toISOString(),
        tokens: byBucket.get(at) ?? 0,
        // The live block — the one still filling, and the one "it resets" refers to.
        isCurrent: i === 0,
      });
    }

    const current = series[series.length - 1];

    return NextResponse.json(
      {
        window: windowKey,
        bucketMs: size,
        series,
        /** Usage in the block still open, and when it rolls over. */
        currentTokens: current.tokens,
        resetsAt: new Date(nowFloor + size).toISOString(),
        /** Everything shown on the chart, so the header can state the span's total. */
        windowTotal: series.reduce((sum, b) => sum + b.tokens, 0),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    logger.error("Failed to load usage history", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to load usage history" }, { status: 500 });
  }
}
