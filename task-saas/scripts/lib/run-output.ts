/**
 * Writing out what a measurement run actually produced.
 *
 * Split from the script so it can be tested without a database, a provider, or an hour
 * of waiting. It exists because of the failure mode it prevents: a run that stops early
 * still measured whatever it measured, and discarding those rows would make the abort
 * worse than the failure it was avoiding.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import type { BreakerState } from "./circuit";

export interface RunSummary {
  /** Cases the run intended to attempt. */
  planned: number;
  /** Cases that actually produced a row. */
  ran: number;
  /** planned - ran. Non-zero only when the breaker tripped. */
  skipped: number;
  aborted: boolean;
  /** The breaker's explanation, or null on a run that finished normally. */
  abortReason: string | null;
  retries: number;
  rateLimitWaits: number;
  totalWaitSeconds: number;
}

export function summarise(input: {
  breaker: BreakerState;
  planned: number;
  results: readonly Record<string, unknown>[];
  rateLimitWaits: number;
  totalWaitMs: number;
}): RunSummary {
  const { breaker, planned, results, rateLimitWaits, totalWaitMs } = input;
  return {
    planned,
    ran: results.length,
    skipped: planned - results.length,
    aborted: breaker.tripped,
    abortReason: breaker.reason,
    retries: results.reduce((sum, r) => sum + Number(r.retries ?? 0), 0),
    rateLimitWaits,
    totalWaitSeconds: Math.round(totalWaitMs / 1000),
  };
}

/**
 * Write results and summary side by side.
 *
 * Called on EVERY exit path, tripped or not — an aborted run is a run with a shorter
 * result set, not a run with no output.
 */
export function writeRunOutputs(
  outDir: string,
  results: readonly Record<string, unknown>[],
  summary: RunSummary
): void {
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2), "utf-8");
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
}
