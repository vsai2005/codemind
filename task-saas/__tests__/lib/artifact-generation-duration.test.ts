import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attemptFromReport, type VerificationReport } from "@/lib/artifacts/verify";

/**
 * Generation duration, and the route that made it necessary.
 *
 * WHY THIS FIELD EXISTS
 * The artifact path never recorded how long the provider call took, so durations had to
 * be reconstructed from consecutive message timestamps — a span that also contains
 * parsing, validation, verification, the zip build and two database writes. That
 * reconstruction is what the 180s non-streaming deadline was sized against, so an
 * estimate that structurally overstates generation was feeding a deadline.
 *
 * THE MEASUREMENT BOUNDARY IS THE THING UNDER TEST. A fixture where the provider call
 * and the surrounding request take the SAME time cannot tell a correct span from one
 * that brackets too much, so every fixture below makes them differ by a wide margin.
 */

describe("the measurement boundary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * Stands in for generateArtifact's shape: a slow provider call wrapped in slow
   * post-processing. Deliberately built so the two spans are far apart — 200ms of
   * provider time inside 1,000ms of total work. Measuring the wrong boundary yields
   * 1000, not 200, and no assertion here would accept both.
   */
  const runLikeGenerateArtifact = async (
    providerMs: number,
    postProcessingMs: number
  ): Promise<{ generationMs: number; totalMs: number }> => {
    const requestStart = Date.now();

    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(providerMs);
    const generationMs = Date.now() - startedAt;

    // Everything that happens AFTER the provider answers, and must not be counted.
    await vi.advanceTimersByTimeAsync(postProcessingMs);

    return { generationMs, totalMs: Date.now() - requestStart };
  };

  it("measures the provider call, not the whole request", async () => {
    const { generationMs, totalMs } = await runLikeGenerateArtifact(200, 800);

    expect(generationMs).toBe(200);
    // Stated explicitly so the two can never be confused for each other.
    expect(totalMs).toBe(1000);
    expect(generationMs).toBeLessThan(totalMs);
  });

  it("does not drift when post-processing dominates", async () => {
    // The realistic zip case: a fast generation followed by verification and packaging.
    const { generationMs, totalMs } = await runLikeGenerateArtifact(50, 5_000);

    expect(generationMs).toBe(50);
    expect(totalMs).toBe(5_050);
  });

  it("does not drift when the provider dominates", async () => {
    // The observed OpenRouter case: 170s of provider time, a moment of everything else.
    const { generationMs, totalMs } = await runLikeGenerateArtifact(170_000, 300);

    expect(generationMs).toBe(170_000);
    expect(totalMs).toBe(170_300);
  });
});

describe("recording it on an attempt", () => {
  const report: VerificationReport = {
    ok: false,
    coverage: "checked",
    checks: [],
    errors: [],
    warnings: [],
  } as unknown as VerificationReport;

  it("carries the duration onto a verification failure", () => {
    // A failure's duration is the point: a 1s failure is a rejected request and a 170s
    // failure is a deadline, and their error strings can be identical.
    const attempt = attemptFromReport(report, "file", 170_000);

    expect(attempt.generationMs).toBe(170_000);
    expect(attempt.ok).toBe(false);
  });

  it("omits the key entirely when no duration was measured", () => {
    // NOT null, NOT zero. The 30 rows written before this field existed have no
    // duration and cannot be given one; storing an explicit null would read as
    // "measured, and it was nothing" and put impossibly fast generations into any
    // measurement taken over this column.
    const attempt = attemptFromReport(report, "file");

    expect(attempt.generationMs).toBeUndefined();
    expect(Object.keys(attempt)).not.toContain("generationMs");
  });

  it("keeps a genuine zero distinguishable from an absent one", () => {
    const measured = attemptFromReport(report, "file", 0);

    expect(measured.generationMs).toBe(0);
    expect(Object.keys(measured)).toContain("generationMs");
  });
});
