"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Token usage over time, for the settings page.
 *
 * WHAT THESE NUMBERS ARE
 * Counts the PROVIDER reported after answering, read back from stored rows — not
 * `estimateTokens`, which guesses before a request to decide what fits in the window.
 * Turns whose provider reported nothing contribute zero here rather than an estimate,
 * because a chart that mixes measured and guessed values cannot be checked against a
 * provider's own accounting.
 *
 * WHY BOTH A HEADLINE AND BARS
 * The headline answers "how much have I used in the block that is still open, and when
 * does it roll over" — the question a rate limit provokes. The bars answer "what does
 * my usage look like over time", which the headline alone cannot show: a single number
 * makes a quiet week and a spiky one identical.
 */

type WindowKey = "5h" | "week" | "month";

interface Bucket {
  startsAt: string;
  tokens: number;
  isCurrent: boolean;
}

interface UsageHistory {
  window: WindowKey;
  bucketMs: number;
  series: Bucket[];
  currentTokens: number;
  resetsAt: string;
  windowTotal: number;
}

const TABS: Array<{ key: WindowKey; label: string; caption: string }> = [
  { key: "5h", label: "5 hours", caption: "Twelve 5-hour blocks. The last bar is the block still filling." },
  { key: "week", label: "Week", caption: "Daily totals for the last 7 days." },
  { key: "month", label: "Month", caption: "Daily totals for the last 30 days." },
];

function parse(body: unknown): UsageHistory | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.series)) return null;

  const series = raw.series.flatMap((entry): Bucket[] => {
    if (!entry || typeof entry !== "object") return [];
    const b = entry as Record<string, unknown>;
    if (typeof b.startsAt !== "string" || typeof b.tokens !== "number") return [];
    return [{ startsAt: b.startsAt, tokens: b.tokens, isCurrent: b.isCurrent === true }];
  });

  return {
    window: (raw.window as WindowKey) ?? "5h",
    bucketMs: typeof raw.bucketMs === "number" ? raw.bucketMs : 0,
    series,
    currentTokens: typeof raw.currentTokens === "number" ? raw.currentTokens : 0,
    resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : "",
    windowTotal: typeof raw.windowTotal === "number" ? raw.windowTotal : 0,
  };
}

const n = (v: number): string => v.toLocaleString("en-US");

/** Label under each bar: a clock time for 5h blocks, a date for daily buckets. */
function bucketLabel(iso: string, bucketMs: number): string {
  const d = new Date(iso);
  if (bucketMs < 24 * 60 * 60 * 1000) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true }).replace(" ", "");
  }
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

/** "in 2h 14m" — how long the open block has left before it rolls over. */
function untilReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function TokenUsagePanel(): React.ReactElement {
  const [active, setActive] = useState<WindowKey>("5h");
  const [data, setData] = useState<UsageHistory | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async (key: WindowKey, signal: AbortSignal) => {
    setState("loading");
    try {
      const res = await fetch(`/api/usage/history?window=${key}`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const parsed = parse(await res.json());
      if (!parsed) throw new Error("malformed");
      setData(parsed);
      setState("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(active, controller.signal);
    return () => controller.abort();
  }, [active, load]);

  const tab = TABS.find((t) => t.key === active)!;
  // Scale to the tallest bar, not to a fixed ceiling: usage spans orders of magnitude
  // between a quiet hour and a long session, and a fixed axis flattens one of them
  // into nothing. Floor of 1 keeps an all-zero series from dividing by zero.
  const peak = Math.max(1, ...(data?.series.map((b) => b.tokens) ?? [0]));

  return (
    <section className="rounded-dialog border border-gray-200 bg-white p-5 shadow-elevated sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Tokens used</h2>
          <p className="mt-1 text-[13px] text-gray-500">
            Reported by the model provider after each reply.
          </p>
        </div>

        <div className="flex shrink-0 rounded-card border border-gray-200 p-0.5" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              onClick={() => setActive(t.key)}
              className={`rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                active === t.key
                  ? "bg-accent-50 text-accent-800"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {state === "error" && (
        <p className="mt-5 text-[13px] text-gray-500">Usage could not be loaded.</p>
      )}

      {state === "loading" && !data && (
        <div className="mt-5 h-40 animate-pulse rounded-card bg-gray-100" />
      )}

      {data && state !== "error" && (
        <>
          {/* Headline: the block still open, and when it rolls over. */}
          <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {active === "5h" ? "Current 5-hour block" : `This ${active === "week" ? "day" : "day"}`}
              </p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums text-gray-900">
                {n(data.currentTokens)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {active === "5h" ? "Last 60 hours" : active === "week" ? "Last 7 days" : "Last 30 days"}
              </p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums text-gray-900">
                {n(data.windowTotal)}
              </p>
            </div>
            <p className="text-[12px] text-gray-500">
              Resets in <span className="font-medium text-gray-700">{untilReset(data.resetsAt)}</span>
            </p>
          </div>

          {/* Bars. Plain flex + heights — no chart dependency for twelve rectangles. */}
          <div className="mt-6">
            <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`Token usage by ${tab.label}`}>
              {data.series.map((b) => {
                const pct = (b.tokens / peak) * 100;
                return (
                  <div key={b.startsAt} className="group relative flex flex-1 flex-col items-center justify-end">
                    <div
                      // A zero bucket still gets a visible sliver, so the axis reads as
                      // continuous rather than as missing data.
                      style={{ height: `${Math.max(pct, b.tokens > 0 ? 4 : 2)}%` }}
                      className={`w-full rounded-t-[3px] transition-colors ${
                        b.isCurrent
                          ? "bg-accent-600"
                          : b.tokens > 0
                            ? "bg-accent-300 group-hover:bg-accent-400"
                            : "bg-gray-200"
                      }`}
                    />
                    <span className="pointer-events-none absolute -top-7 z-10 hidden whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-[11px] tabular-nums text-white group-hover:block">
                      {n(b.tokens)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="mt-2 flex gap-1.5">
              {data.series.map((b, i) => (
                <span
                  key={b.startsAt}
                  className={`flex-1 text-center text-[10px] tabular-nums ${
                    b.isCurrent ? "font-semibold text-accent-700" : "text-gray-400"
                  }`}
                >
                  {/* Every other label on the 30-day view, or they collide. */}
                  {data.series.length > 12 && i % 3 !== 0 && !b.isCurrent
                    ? ""
                    : bucketLabel(b.startsAt, data.bucketMs)}
                </span>
              ))}
            </div>
          </div>

          <p className="mt-4 text-[12px] text-gray-500">{tab.caption}</p>
        </>
      )}
    </section>
  );
}
