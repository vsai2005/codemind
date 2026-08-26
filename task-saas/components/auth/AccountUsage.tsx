"use client";

import { useEffect, useState } from "react";

/**
 * Lifetime token usage, in the account menu.
 *
 * There is no profile page in this app — the account dropdown is the only per-user
 * surface — so the profile-level total lives here rather than behind a new route
 * built solely to hold one number.
 *
 * Counts only. No pricing: a token count is something the provider reported, while a
 * cost is a claim about a rate card that changes without notice, and showing a stale
 * one next to a real count would make both look equally authoritative.
 */

interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reportedMessages: number;
  unreportedMessages: number;
}

function parseUsage(body: unknown): Usage | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.totalTokens !== "number") return null;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    promptTokens: num(raw.promptTokens),
    completionTokens: num(raw.completionTokens),
    totalTokens: raw.totalTokens,
    reportedMessages: num(raw.reportedMessages),
    unreportedMessages: num(raw.unreportedMessages),
  };
}

export function AccountUsage(): React.ReactElement | null {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch("/api/usage", { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const parsed = parseUsage(await res.json());
        if (parsed) setUsage(parsed);
        else setFailed(true);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      }
    })();

    return () => controller.abort();
  }, []);

  // A usage read failing must not take the sign-out button down with it.
  if (failed) return null;

  if (!usage) {
    return (
      <div className="border-b border-gray-100 px-3 py-2.5">
        <div className="h-3 w-24 animate-pulse rounded bg-gray-200" />
      </div>
    );
  }

  const n = (v: number): string => v.toLocaleString("en-US");

  return (
    <div className="border-b border-gray-100 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
        Tokens used
      </p>
      <p className="mt-1 text-[13px] font-semibold tabular-nums text-gray-900">
        {n(usage.totalTokens)}
      </p>
      <p className="mt-0.5 text-[11px] tabular-nums text-gray-500">
        {n(usage.promptTokens)} prompt · {n(usage.completionTokens)} completion
      </p>
      {usage.unreportedMessages > 0 && (
        // Stated, not folded in. Some providers report no usage at all, and a total
        // that silently excluded them would read as lower activity rather than
        // incomplete measurement.
        <p className="mt-1 text-[11px] text-gray-400">
          {n(usage.unreportedMessages)} repl
          {usage.unreportedMessages === 1 ? "y" : "ies"} not reported by the provider
        </p>
      )}
    </div>
  );
}
