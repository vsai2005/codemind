import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const queryRaw = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

import { GET } from "@/app/api/usage/history/route";
import { auth } from "@/auth";

/**
 * Bucketed usage history.
 *
 * WHAT THIS PROTECTS
 * The chart's honesty rests on three properties that are easy to break and invisible
 * when broken:
 *
 *   1. Bucket boundaries are FIXED to an epoch grid, not counted back from "now". If
 *      they floated, the same message would move between bars depending on when the
 *      page was opened, and a chart that reshuffles on refresh is worse than none.
 *   2. Every bucket in the window is present. Rows exist only where there was activity,
 *      so a gap must be filled with an explicit zero — otherwise an idle block silently
 *      collapses the axis and the spacing between bars becomes a lie.
 *   3. The header total equals what the bars show. A window total computed over a
 *      different span than the series would disagree with the picture beside it.
 *
 * FIVE HOURS IS 18000 SECONDS. That constant appears in the SQL and, as
 * 5 * 60 * 60 * 1000, in the JavaScript that fills gaps. They must agree, or rows land
 * in buckets the series never emits and those tokens vanish from the chart entirely.
 */

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const req = (window?: string): Request =>
  new Request(
    `http://localhost:3000/api/usage/history${window ? `?window=${window}` : ""}`
  );

/** The epoch-floored start of the block containing `at` — what the SQL emits. */
const floor = (at: number, size: number): number => Math.floor(at / size) * size;

describe("usage history", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    queryRaw.mockResolvedValue([]);
    vi.useFakeTimers();
    // A deliberately untidy instant: not on a bucket edge, not on the hour, so an
    // off-by-one in the flooring shows up rather than hiding behind round numbers.
    vi.setSystemTime(new Date("2026-08-31T13:47:19.512Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("emits every bucket in the window, filling idle blocks with an explicit zero", async () => {
    // One block of activity, ten blocks back. Everything else is silence.
    const active = floor(Date.now(), FIVE_HOURS_MS) - 10 * FIVE_HOURS_MS;
    queryRaw.mockResolvedValue([{ bucket: new Date(active), total: BigInt(530) }]);

    const body = await (await GET(req("5h"))).json();

    expect(body.series).toHaveLength(12);
    expect(body.series.filter((b: { tokens: number }) => b.tokens > 0)).toHaveLength(1);
    // The zeros are present, not absent: a gap has to occupy space on the axis.
    expect(body.series.filter((b: { tokens: number }) => b.tokens === 0)).toHaveLength(11);
  });

  it("puts a row in the bar its timestamp belongs to, not an adjacent one", async () => {
    // The alignment check. Two blocks back from the open one, so a wrong grid or a
    // mismatched constant would place it elsewhere in the series — or nowhere at all.
    const target = floor(Date.now(), FIVE_HOURS_MS) - 2 * FIVE_HOURS_MS;
    queryRaw.mockResolvedValue([{ bucket: new Date(target), total: 1234 }]);

    const body = await (await GET(req("5h"))).json();

    const index = body.series.findIndex(
      (b: { startsAt: string }) => new Date(b.startsAt).getTime() === target
    );
    expect(index).toBe(9); // twelve buckets; index 11 is current, so two back is 9
    expect(body.series[index].tokens).toBe(1234);
  });

  it("anchors buckets to a fixed epoch grid so bars do not move between reads", async () => {
    // Read at two different instants inside the SAME block. If boundaries were counted
    // back from "now", every startsAt would shift by the forty minutes between reads
    // and the chart would reshuffle on refresh.
    const first = await (await GET(req("5h"))).json();

    vi.setSystemTime(new Date("2026-08-31T14:27:03.004Z"));
    const second = await (await GET(req("5h"))).json();

    expect(second.series.map((b: { startsAt: string }) => b.startsAt)).toEqual(
      first.series.map((b: { startsAt: string }) => b.startsAt)
    );
    expect(second.resetsAt).toBe(first.resetsAt);

    // And it is the same grid the SQL floors onto: every start is a whole multiple of
    // five hours since the epoch.
    for (const bucket of second.series) {
      expect(new Date(bucket.startsAt).getTime() % FIVE_HOURS_MS).toBe(0);
    }
  });

  it("marks only the open block as current and resets at its far edge", async () => {
    const now = Date.now();
    const open = floor(now, FIVE_HOURS_MS);
    queryRaw.mockResolvedValue([{ bucket: new Date(open), total: 88 }]);

    const body = await (await GET(req("5h"))).json();

    const current = body.series.filter((b: { isCurrent: boolean }) => b.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]).toEqual(body.series[body.series.length - 1]);
    expect(body.currentTokens).toBe(88);

    // "Resets in ..." must point forward, and by no more than one block — a reset
    // further out than the block length means the countdown stops matching the bar.
    const resets = new Date(body.resetsAt).getTime();
    expect(resets).toBe(open + FIVE_HOURS_MS);
    expect(resets).toBeGreaterThan(now);
    expect(resets - now).toBeLessThanOrEqual(FIVE_HOURS_MS);
  });

  it("reports a window total that equals the bars beside it", async () => {
    const base = floor(Date.now(), FIVE_HOURS_MS);
    queryRaw.mockResolvedValue([
      { bucket: new Date(base - 3 * FIVE_HOURS_MS), total: 100 },
      { bucket: new Date(base - FIVE_HOURS_MS), total: 250 },
      { bucket: new Date(base), total: 42 },
    ]);

    const body = await (await GET(req("5h"))).json();

    const drawn = body.series.reduce(
      (sum: number, b: { tokens: number }) => sum + b.tokens,
      0
    );
    expect(body.windowTotal).toBe(392);
    expect(body.windowTotal).toBe(drawn);
  });

  it("counts a bigint sum as a number rather than serialising it as a string", async () => {
    // SUM() over an integer column comes back from Postgres as bigint. Passed through
    // untouched it either throws on JSON.stringify or reaches the client as "530",
    // and every arithmetic comparison in the chart then misbehaves silently.
    queryRaw.mockResolvedValue([
      { bucket: new Date(floor(Date.now(), FIVE_HOURS_MS)), total: BigInt(530) },
    ]);

    const body = await (await GET(req("5h"))).json();

    expect(body.currentTokens).toBe(530);
    expect(typeof body.currentTokens).toBe("number");
  });

  it("switches bucket size and count with the window", async () => {
    const week = await (await GET(req("week"))).json();
    expect(week.window).toBe("week");
    expect(week.series).toHaveLength(7);
    expect(week.bucketMs).toBe(DAY_MS);

    const month = await (await GET(req("month"))).json();
    expect(month.window).toBe("month");
    expect(month.series).toHaveLength(30);
    expect(month.bucketMs).toBe(DAY_MS);
  });

  it("falls back to the 5-hour window for a missing or unrecognised parameter", async () => {
    for (const request of [req(), req("fortnight"), req("..%2F..%2Fetc")]) {
      const body = await (await GET(request)).json();
      expect(body.window).toBe("5h");
      expect(body.bucketMs).toBe(FIVE_HOURS_MS);
    }
  });

  it("scopes the query to the signed-in user, bound as a parameter rather than spliced into SQL", async () => {
    await GET(req("5h"));

    // $queryRaw is called as a tagged template: the literal fragments first, then the
    // interpolated values.
    const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(values).toContain("user-1");
    // The id must not appear in the literal SQL — that is what makes it a bound
    // parameter rather than string concatenation.
    expect(strings.join("?")).not.toContain("user-1");
    expect(strings.join("?")).toContain('c."userId"');
  });

  it("floors in SQL onto the same grid the gap-filling uses in JavaScript", async () => {
    // The one property the mock cannot otherwise see. Everything above asserts against
    // rows this test file invented, so the real SQL's divisor could drift to any value
    // and every other test would still pass — while in production the rows would land
    // on a grid the series never emits and the tokens would disappear from the chart.
    // Reading the divisor out of the query text is what ties the two halves together.
    await GET(req("5h"));

    const [strings] = queryRaw.mock.calls[0] as [string[]];
    expect(strings.join("?")).toContain(`/ ${FIVE_HOURS_MS / 1000})`);
  });

  it("refuses an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(req("5h"));

    expect(res.status).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("fails with a 500 rather than a half-drawn chart when the query errors", async () => {
    queryRaw.mockRejectedValue(new Error("connection terminated"));

    const res = await GET(req("5h"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });
});
