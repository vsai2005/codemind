import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  attemptsFor,
  initialBreaker,
  recordFailure,
  recordSuccess,
  CONSECUTIVE_FAILURE_LIMIT,
  type BreakerState,
  type FailureKind,
} from "@/scripts/lib/circuit";
import { summarise, writeRunOutputs } from "@/scripts/lib/run-output";

/**
 * The circuit breaker for the measurement harness.
 *
 * THE RUN THIS EXISTS BECAUSE OF
 * A 42-case run produced 42 consecutive generation failures, every one "Too Many
 * Requests", after 126 retries and 11,864 seconds of deliberate waiting. Three hours
 * twenty, a full day's allowance, no artifacts. Nothing in the harness could conclude
 * "this run cannot succeed", so it worked the whole case list failing identically.
 *
 * COUNTS ARE WRITTEN AS LITERALS ON PURPOSE.
 * Asserting against CONSECUTIVE_FAILURE_LIMIT would make the threshold tests pass for
 * ANY value of it - the mutation would move the fixture along with the code. So the
 * fixtures below fail exactly twice and exactly three times, spelled out, and one
 * separate assertion pins the constant itself, so a deliberate retune fails loudly
 * rather than quietly hollowing out the boundary tests.
 */

const fail = (state: BreakerState, times: number, kind: FailureKind = "rate-limit") => {
  let s = state;
  for (let i = 0; i < times; i++) s = recordFailure(s, kind);
  return s;
};

describe("the threshold", () => {
  it("is the value these fixtures are built around", () => {
    // Guards the guard: if someone retunes the limit, the fixtures below stop testing
    // the boundary, and this says so instead of passing vacuously.
    expect(CONSECUTIVE_FAILURE_LIMIT).toBe(3);
  });

  it("trips on three consecutive failures", () => {
    // Raising the limit to 4 makes this fail. BY CONSTRUCTION: the fixture supplies
    // exactly three failures, so the assertion is about the number three, not about
    // whatever the constant happens to say.
    const state = fail(initialBreaker(), 3);

    expect(state.tripped).toBe(true);
    expect(state.consecutive).toBe(3);
  });

  it("does not trip on two", () => {
    // Lowering the limit to 2 makes this fail. The pair pins the threshold from both
    // sides; neither test alone would.
    const state = fail(initialBreaker(), 2);

    expect(state.tripped).toBe(false);
    expect(state.consecutive).toBe(2);
  });

  it("does not trip on one", () => {
    expect(fail(initialBreaker(), 1).tripped).toBe(false);
  });

  it("explains itself, naming the classification that tripped it", () => {
    // The reason is the whole user-facing output of an abort. An empty or generic one
    // would leave the run indistinguishable from a crash.
    const limited = fail(initialBreaker(), 3, "rate-limit");
    const stalled = fail(initialBreaker(), 3, "transport");

    expect(limited.reason).toMatch(/rate-limited/i);
    expect(limited.reason).toMatch(/quota/i);
    expect(stalled.reason).toMatch(/transport/i);
    expect(stalled.reason).not.toBe(limited.reason);
  });

  it("stays tripped - further turns cannot un-trip it", () => {
    // Terminal by design. If a stray success could clear it, the run would resume into
    // the same wall it just decided to stop hitting.
    const tripped = fail(initialBreaker(), 3);

    expect(recordSuccess(tripped).tripped).toBe(true);
    expect(recordFailure(tripped, "transport").tripped).toBe(true);
    expect(recordSuccess(tripped).reason).toBe(tripped.reason);
  });
});

describe("a success in the middle of a bad patch", () => {
  it("resets the counter to zero, not by one", () => {
    // BY CONSTRUCTION AGAINST TWO SEPARATE MUTATIONS.
    // Two failures, a success, two more failures - five turns, never three in a row.
    //   - if recordSuccess were a no-op:        2 + 2 = 4 >= 3, trips. Caught.
    //   - if it decremented instead of zeroing: 2 - 1 + 2 = 3 >= 3, trips. Caught.
    // A fixture with a single leading failure would survive both, which is why there
    // are two.
    let state = fail(initialBreaker(), 2);
    state = recordSuccess(state);
    state = fail(state, 2);

    expect(state.tripped).toBe(false);
    expect(state.consecutive).toBe(2);
  });

  it("clears the remembered classification too", () => {
    const state = recordSuccess(fail(initialBreaker(), 2));

    expect(state.consecutive).toBe(0);
    expect(state.kind).toBeNull();
  });

  it("lets an alternating run continue indefinitely", () => {
    // A flaky provider is still producing data, and that is exactly the run worth
    // finishing. Counting totals rather than consecutives would abort it around turn six.
    let state = initialBreaker();
    for (let i = 0; i < 20; i++) {
      state = recordFailure(state, "rate-limit");
      state = recordFailure(state, "rate-limit");
      state = recordSuccess(state);
    }

    expect(state.tripped).toBe(false);
  });
});

describe("mixed classifications", () => {
  it("restarts the count when the classification changes", () => {
    // Two rate limits and a stall are not three of anything. If the count carried across
    // kinds, this third failure would trip on evidence pointing nowhere in particular.
    let state = fail(initialBreaker(), 2, "rate-limit");
    state = recordFailure(state, "transport");

    expect(state.tripped).toBe(false);
    expect(state.consecutive).toBe(1);
    expect(state.kind).toBe("transport");
  });

  it("still trips once one classification reaches three on its own", () => {
    let state = fail(initialBreaker(), 2, "rate-limit");
    state = fail(state, 3, "transport");

    expect(state.tripped).toBe(true);
    expect(state.reason).toMatch(/transport/i);
  });
});

describe("retries after a rate limit", () => {
  it("gives the first rate-limited turn its full allowance", () => {
    // That turn IS the experiment: it tests whether waiting out the window helps.
    expect(attemptsFor(initialBreaker(), "rate-limit", 3)).toBe(3);
  });

  it("gives a second rate-limited turn none", () => {
    // THE COST FIX. One full backoff cycle already tested the burst hypothesis; a second
    // turn hitting the same wall has disproved it, and every further attempt spends
    // quota - the scarce resource - to learn nothing. On the run that prompted this,
    // 126 such attempts were spent across 11,864 seconds.
    const state = fail(initialBreaker(), 1, "rate-limit");

    expect(attemptsFor(state, "rate-limit", 3)).toBe(1);
  });

  it("keeps retrying transport stalls even after a rate limit", () => {
    // Different physics: a stalled connection genuinely does recover on a timescale
    // retrying can reach, so the quota argument does not apply to it.
    const state = fail(initialBreaker(), 1, "rate-limit");

    expect(attemptsFor(state, "transport", 3)).toBe(3);
  });

  it("restores the full allowance after a success", () => {
    // The suppression answers a live pattern; it is not a permanent downgrade.
    const state = recordSuccess(fail(initialBreaker(), 1, "rate-limit"));

    expect(attemptsFor(state, "rate-limit", 3)).toBe(3);
  });

  it("does not suppress retries after a transport failure", () => {
    const state = fail(initialBreaker(), 1, "transport");

    expect(attemptsFor(state, "rate-limit", 3)).toBe(3);
  });
});

describe("what a tripped run leaves behind", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "measure-circuit-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("writes the partial results it did collect, and they are readable", () => {
    // The failure this prevents: aborting early to save an afternoon, then discarding
    // the cases that DID measure something. That would be worse than not aborting.
    withDir((dir) => {
      const results = [
        { arm: "A", label: "one", ok: true, retries: 0 },
        { arm: "A", label: "two", ok: false, retries: 3 },
      ];
      const summary = summarise({
        breaker: fail(initialBreaker(), 3),
        planned: 42,
        results,
        rateLimitWaits: 6,
        totalWaitMs: 90_000,
      });

      writeRunOutputs(dir, results, summary);

      const written = JSON.parse(readFileSync(join(dir, "results.json"), "utf-8"));
      expect(written).toHaveLength(2);
      expect(written[1].label).toBe("two");
    });
  });

  it("records that it aborted, why, and how much it skipped", () => {
    withDir((dir) => {
      const results = [{ retries: 3 }, { retries: 3 }];
      const summary = summarise({
        breaker: fail(initialBreaker(), 3),
        planned: 42,
        results,
        rateLimitWaits: 6,
        totalWaitMs: 90_000,
      });

      writeRunOutputs(dir, results, summary);
      const written = JSON.parse(readFileSync(join(dir, "summary.json"), "utf-8"));

      expect(written.aborted).toBe(true);
      expect(written.abortReason).toMatch(/consecutive/i);
      expect(written.ran).toBe(2);
      expect(written.skipped).toBe(40);
      expect(written.retries).toBe(6);
      expect(written.totalWaitSeconds).toBe(90);
    });
  });

  it("reports a completed run as not aborted, with nothing skipped", () => {
    // `skipped: 0` and `aborted: false` have to be distinguishable from an abort, or the
    // summary cannot be read without already knowing what happened.
    const summary = summarise({
      breaker: initialBreaker(),
      planned: 2,
      results: [{ retries: 0 }, { retries: 1 }],
      rateLimitWaits: 1,
      totalWaitMs: 0,
    });

    expect(summary.aborted).toBe(false);
    expect(summary.abortReason).toBeNull();
    expect(summary.skipped).toBe(0);
  });
});
