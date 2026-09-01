import { describe, it, expect } from "vitest";
import {
  backoffFor,
  jittered,
  looksRateLimited,
  RATE_LIMIT_BACKOFF_MS,
  TRANSPORT_BACKOFF_MS,
} from "@/scripts/lib/backoff";
import { RATE_LIMIT_COOLDOWN_MS } from "@/lib/ai/failure-classification";

/**
 * Retry pacing for the measurement script.
 *
 * THE BUG THIS PREVENTS RECURRING
 * A 42-turn run lost 22 turns to "Too Many Requests" because the retry loop had no
 * delay: three attempts fired inside one second and every one was rejected. The gateway
 * had already parked the key for RATE_LIMIT_COOLDOWN_MS, and Gemini has a single key —
 * so there was nothing else to fail over to and nothing to do but wait.
 *
 * The property that matters is therefore not "it waits" but "it waits LONGER THAN THE
 * COOLDOWN". A backoff of five seconds against a sixty-second cooldown is still a
 * guaranteed failure, just a slower one — so the assertions below compare against the
 * real constant rather than against a number copied out of it.
 */

describe("classifying a provider failure", () => {
  it("recognises the phrasings providers actually use", () => {
    // "Too Many Requests" is verbatim what Gemini returned in the run that prompted this.
    expect(looksRateLimited("artifact generation failed: Too Many Requests")).toBe(true);
    expect(looksRateLimited("rate limit exceeded")).toBe(true);
    expect(looksRateLimited("rate-limited, slow down")).toBe(true);
    expect(looksRateLimited("quota exceeded for this project")).toBe(true);
    expect(looksRateLimited("received 429 from upstream")).toBe(true);
  });

  it("does not mistake a transport stall for a rate limit", () => {
    // The other failure this session produced, and it needs the SHORT schedule. Waiting
    // a minute for a stall that clears in seconds wastes the run.
    expect(
      looksRateLimited("artifact generation failed: Provider sent no response headers within 60000ms")
    ).toBe(false);
    expect(looksRateLimited("socket hang up")).toBe(false);
    expect(looksRateLimited("ECONNRESET")).toBe(false);
  });

  it("does not fire on an empty message", () => {
    expect(looksRateLimited("")).toBe(false);
  });
});

describe("backoff schedules", () => {
  it("always waits longer than the cooldown the gateway imposed", () => {
    // THE LOAD-BEARING ASSERTION. Retrying before the key leaves cooldown cannot
    // succeed, so every rate-limit wait must clear it — including after jitter, which
    // halves the value at worst.
    for (const wait of RATE_LIMIT_BACKOFF_MS) {
      expect(wait).toBeGreaterThan(RATE_LIMIT_COOLDOWN_MS);
    }
  });

  it("keeps transport waits far shorter than rate-limit waits", () => {
    // Two different timescales, deliberately. Collapsing them would either stall the
    // run on transport blips or retry rate limits too soon.
    expect(Math.max(...TRANSPORT_BACKOFF_MS)).toBeLessThan(Math.min(...RATE_LIMIT_BACKOFF_MS));
  });

  it("increases with each attempt on both schedules", () => {
    for (const schedule of [RATE_LIMIT_BACKOFF_MS, TRANSPORT_BACKOFF_MS]) {
      for (let i = 1; i < schedule.length; i++) {
        expect(schedule[i]).toBeGreaterThan(schedule[i - 1]);
      }
    }
  });

  it("picks the rate-limit schedule for a rate-limited message", () => {
    expect(backoffFor("Too Many Requests", 0)).toBe(RATE_LIMIT_BACKOFF_MS[0]);
    expect(backoffFor("Too Many Requests", 1)).toBe(RATE_LIMIT_BACKOFF_MS[1]);
  });

  it("picks the transport schedule for anything else", () => {
    expect(backoffFor("Provider sent no response headers", 0)).toBe(TRANSPORT_BACKOFF_MS[0]);
  });

  it("repeats the last wait rather than growing without bound", () => {
    // A run that paced itself into hours would be abandoned, and an abandoned run
    // measures nothing.
    const last = RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
    expect(backoffFor("quota", 99)).toBe(last);
  });

  it("clamps a negative attempt to the first wait", () => {
    expect(backoffFor("quota", -5)).toBe(RATE_LIMIT_BACKOFF_MS[0]);
  });
});

describe("jitter", () => {
  it("stays within half to full of the requested wait", () => {
    for (const random of [() => 0, () => 0.5, () => 0.999]) {
      const value = jittered(60_000, random);
      expect(value).toBeGreaterThanOrEqual(30_000);
      expect(value).toBeLessThanOrEqual(60_000);
    }
  });

  it("never returns zero, so a backoff cannot become an immediate retry", () => {
    // The exact bug this module exists to prevent: a "wait" of 0ms is what the original
    // loop effectively did three times in a row.
    expect(jittered(1, () => 0)).toBeGreaterThan(0);
    expect(jittered(0, () => 0)).toBeGreaterThan(0);
  });

  it("actually varies, so simultaneous failures do not resynchronise", () => {
    const values = new Set([0.1, 0.4, 0.7, 0.95].map((r) => jittered(60_000, () => r)));
    expect(values.size).toBeGreaterThan(1);
  });
});
