import { describe, it, expect, afterEach, vi } from "vitest";
import {
  classifyNetworkError,
  isAbortError,
  NO_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
} from "@/lib/ai/failure-classification";
import {
  ProviderDeadlineError,
  isProviderDeadlineError,
  fetchWithHeaderTimeout,
} from "@/lib/ai/fetch-timeout";
import { acquireKey, getKeyStats, __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * A deadline we imposed is not a failure the provider committed.
 *
 * THE DEFECT THIS PINS DOWN
 * The header timer aborted with a bare `new Error(...)`. A plain Error matches none of
 * the names `isAbortError` looks for, so it fell through to `kind: "network"` —
 * shouldFailover true, 30s cooldown — and the gateway benched a healthy key because a
 * generation was slower than a deadline WE picked. Measured: one 500-token request
 * cooled three of six keys and took 175s to surface, logging `kind: "network"` and
 * `reason: "Network/transport failure (Error)"`. Two of those three attempts were our
 * own timer; only the third was a real provider verdict.
 *
 * THE FIXTURES ARE GENUINELY DIFFERENT OBJECTS, which is the only way this proves
 * anything. A deadline abort, a browser disconnect and a dropped socket are constructed
 * below as three distinct error shapes — a typed ProviderDeadlineError, a DOMException-
 * shaped AbortError, and a TypeError carrying ECONNRESET. A fixture that used the same
 * object for two of them could not tell a correct branch from one that collapsed them.
 */

/** What a user navigating away produces: the runtime's own abort. */
const browserDisconnect = (): Error => {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
};

/** What a provider dropping the connection produces. */
const socketDrop = (): Error => {
  const e = new TypeError("fetch failed");
  (e as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
  return e;
};

/** What a provider stalling at the TCP level produces under undici. */
const undiciSocketError = (): Error => {
  const e = new TypeError("fetch failed");
  (e as Error & { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
  return e;
};

describe("telling the three abort sources apart", () => {
  it("recognises only our own timer as a deadline", () => {
    expect(isProviderDeadlineError(new ProviderDeadlineError(60_000, true))).toBe(true);
    expect(isProviderDeadlineError(browserDisconnect())).toBe(false);
    expect(isProviderDeadlineError(socketDrop())).toBe(false);
    expect(isProviderDeadlineError(new Error("Provider sent no response headers"))).toBe(false);
  });

  it("is not also an abort, which is why the two branches cannot collapse", () => {
    // The property that makes the branch order in classifyNetworkError irrelevant.
    // Worth asserting precisely because it is invisible: a reader seeing the deadline
    // test placed first may assume the order is protecting something, and mutation
    // testing confirmed it is not — swapping the blocks changes no verdict. What DOES
    // protect the separation is this disjointness, so it is pinned here rather than
    // left to be rediscovered.
    expect(isAbortError(new ProviderDeadlineError(60_000, true))).toBe(false);
    expect(isProviderDeadlineError(browserDisconnect())).toBe(false);
  });

  it("cannot be spoofed by a provider error that merely says the same words", () => {
    // The old detection was the message text. A provider is perfectly capable of
    // returning the word "deadline", and the message now embeds a varying number.
    const impostor = new Error("Generation did not complete within 180000ms");

    expect(isProviderDeadlineError(impostor)).toBe(false);
    expect(classifyNetworkError(impostor).kind).toBe("network");
  });
});

describe("classifying a deadline we imposed", () => {
  it("does not blame the key: no cooldown, no failover", () => {
    // THE FIX, in one assertion. Before it, every field on this object was the opposite.
    const c = classifyNetworkError(new ProviderDeadlineError(180_000, false));

    expect(c.kind).toBe("deadline");
    expect(c.cooldownMs).toBe(NO_COOLDOWN_MS);
    expect(c.cooldownMs).toBe(0);
    expect(c.shouldFailover).toBe(false);
    expect(c.markUnhealthy).toBe(false);
  });

  it("names the deadline and the shape it applied to", () => {
    // "Network/transport failure (Error)" sent the diagnosis at the provider for a day.
    // The reason has to say what actually happened.
    const streamed = classifyNetworkError(new ProviderDeadlineError(60_000, true));
    const completion = classifyNetworkError(new ProviderDeadlineError(180_000, false));

    expect(streamed.reason).toContain("60000ms");
    expect(streamed.reason).toContain("streaming");
    expect(streamed.reason).not.toMatch(/network/i);

    expect(completion.reason).toContain("180000ms");
    expect(completion.reason).toContain("non-streaming");
    expect(completion.reason).not.toMatch(/network/i);
  });

  it("tells the caller the generation ran out of time, not that the provider failed", () => {
    const completion = new ProviderDeadlineError(180_000, false);
    const streamed = new ProviderDeadlineError(60_000, true);

    expect(completion.message).toContain("180000ms");
    expect(completion.message).toMatch(/did not complete/i);
    // The non-streaming message must not claim the provider sent no headers — on that
    // path the wait covered the whole generation, and saying otherwise is what made
    // this look like an outage.
    expect(completion.message).not.toMatch(/no response headers/i);
    expect(streamed.message).toMatch(/no response headers/i);
  });

  it("carries the deadline and shape as data, not only prose", () => {
    const e = new ProviderDeadlineError(180_000, false);

    expect(e.deadlineMs).toBe(180_000);
    expect(e.streaming).toBe(false);
    expect(e.name).toBe("ProviderDeadlineError");
  });
});

describe("genuine provider failures are untouched", () => {
  it("still cools the key down for a dropped socket", () => {
    // The policy for real faults must not have moved. If this weakened, the fix would
    // have traded a false outage for an undetected one.
    const c = classifyNetworkError(socketDrop());

    expect(c.kind).toBe("network");
    expect(c.shouldFailover).toBe(true);
    expect(c.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    expect(c.cooldownMs).toBeGreaterThan(0);
  });

  it("still cools the key down for a stalled socket", () => {
    const c = classifyNetworkError(undiciSocketError());

    expect(c.kind).toBe("network");
    expect(c.shouldFailover).toBe(true);
    expect(c.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
  });

  it("still treats a browser disconnect as an abort, not a deadline", () => {
    // Both leave the key unpunished, but they are different events: nobody is waiting
    // on an abort, whereas a deadline still owes its caller an error.
    const c = classifyNetworkError(browserDisconnect());

    expect(c.kind).toBe("aborted");
    expect(c.cooldownMs).toBe(NO_COOLDOWN_MS);
    expect(c.shouldFailover).toBe(false);
    expect(isAbortError(browserDisconnect())).toBe(true);
  });

  it("keeps the three verdicts distinct", () => {
    // Named explicitly, because collapsing any two of them is exactly the class of bug
    // this fix exists for.
    const kinds = [
      classifyNetworkError(new ProviderDeadlineError(60_000, true)).kind,
      classifyNetworkError(browserDisconnect()).kind,
      classifyNetworkError(socketDrop()).kind,
    ];

    expect(kinds).toEqual(["deadline", "aborted", "network"]);
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("what the gateway does with each verdict", () => {
  /**
   * The gateway branches on `kind`, so these assertions state the contract that branch
   * relies on. `reportFailure` is what increments failureCount and sets cooldownUntil;
   * a verdict that reaches it takes the key out of the pool.
   */
  const reachesReportFailure = (error: unknown): boolean => {
    const c = classifyNetworkError(error);
    return c.kind !== "aborted" && c.kind !== "deadline";
  };

  it("keeps a deadline-aborted key in the pool", () => {
    expect(reachesReportFailure(new ProviderDeadlineError(180_000, false))).toBe(false);
  });

  it("keeps a caller-aborted key in the pool", () => {
    expect(reachesReportFailure(browserDisconnect())).toBe(false);
  });

  it("still benches a key that genuinely failed", () => {
    expect(reachesReportFailure(socketDrop())).toBe(true);
  });

  it("spends no failover attempts on a deadline", () => {
    // Three attempts at the non-streaming deadline would be nine minutes to reach the
    // same non-answer, on an endpoint already established to be too slow.
    expect(classifyNetworkError(new ProviderDeadlineError(180_000, false)).shouldFailover).toBe(
      false
    );
    // A real fault still gets its retries.
    expect(classifyNetworkError(socketDrop()).shouldFailover).toBe(true);
  });
});

describe("the key pool after a deadline", () => {
  const KEY_VARS = [
    "NVIDIA_API_KEY_1",
    "NVIDIA_API_KEY_2",
    "NVIDIA_API_KEY_3",
    "NVIDIA_API_KEY",
  ] as const;

  const configureKeys = (count: number): void => {
    for (const name of KEY_VARS) delete process.env[name];
    for (let i = 1; i <= count; i++) process.env[`NVIDIA_API_KEY_${i}`] = `secret-${i}`;
    __resetScheduler();
  };

  afterEach(() => {
    for (const name of KEY_VARS) delete process.env[name];
    __resetScheduler();
  });

  it("leaves a deadline-aborted key immediately reusable", () => {
    // Exercises the real scheduler, not a restatement of the branch. The gateway calls
    // release() for a deadline, which is what this asserts the effect of: the key is
    // healthy, uncooled, and its failure counter untouched.
    configureKeys(3);
    const lease = acquireKey();
    expect(lease).not.toBeNull();

    lease!.release();

    const stats = getKeyStats().find((k) => k.id === lease!.id)!;
    expect(stats.status).toBe("healthy");
    expect(stats.cooldownUntil).toBeLessThanOrEqual(Date.now());
    expect(stats.failureCount).toBe(0);
    expect(stats.activeRequests).toBe(0);
  });

  it("still benches a key that reported a genuine failure", () => {
    // The contrast that makes the assertion above mean something: the same scheduler,
    // the same lease shape, a real fault — and the key goes out of the pool.
    configureKeys(3);
    const lease = acquireKey();

    lease!.reportFailure(classifyNetworkError(socketDrop()));

    const stats = getKeyStats().find((k) => k.id === lease!.id)!;
    expect(stats.status).toBe("cooling");
    expect(stats.cooldownUntil).toBeGreaterThan(Date.now());
    expect(stats.failureCount).toBe(1);
  });

  it("does not shrink the usable pool across repeated deadlines", () => {
    // The observed symptom: one 500-token request cooled three of six keys. Three
    // consecutive deadlines must leave every key selectable.
    configureKeys(3);

    for (let i = 0; i < 3; i++) acquireKey()!.release();

    expect(getKeyStats().every((k) => k.status === "healthy")).toBe(true);
    expect(getKeyStats().filter((k) => k.status === "healthy")).toHaveLength(3);
  });
});

describe("the error the timer actually throws", () => {
  /**
   * CLOSES A FALSE NEGATIVE IN THIS FILE.
   *
   * Every other fixture here constructs a ProviderDeadlineError by hand, which tests
   * the classifier but says nothing about what the timer emits. Mutation-checking found
   * it: reverting the timer to `new Error(...)` — the exact original defect — left all
   * seventeen tests passing. These drive the real timer and classify what comes out of
   * it, so the wire between the two is covered rather than assumed.
   */
  const hangingFetch = () => {
    const mock = vi.fn(
      (_input: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted"))
          );
        })
    );
    vi.stubGlobal("fetch", mock);
    return mock;
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const raise = async (body: string, deadline: number): Promise<unknown> => {
    vi.useFakeTimers();
    hangingFetch();
    const settled = fetchWithHeaderTimeout(
      "https://example.test/v1/chat/completions",
      { body },
      deadline
    ).then(
      () => null,
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(deadline + 1_000);
    return settled;
  };

  it("throws a typed deadline error, not a plain one", async () => {
    const error = await raise(JSON.stringify({ stream: false }), 180_000);

    expect(isProviderDeadlineError(error)).toBe(true);
    expect((error as ProviderDeadlineError).deadlineMs).toBe(180_000);
    expect((error as ProviderDeadlineError).streaming).toBe(false);
  });

  it("is classified as a deadline, so the key survives it", async () => {
    // The whole chain in one assertion: timer -> thrown error -> classifier -> the
    // verdict the gateway branches on.
    const error = await raise(JSON.stringify({ stream: false }), 180_000);
    const c = classifyNetworkError(error);

    expect(c.kind).toBe("deadline");
    expect(c.cooldownMs).toBe(0);
    expect(c.shouldFailover).toBe(false);
  });

  it("stamps the streaming shape on a streamed request", async () => {
    const error = await raise(JSON.stringify({ stream: true }), 60_000);

    expect(isProviderDeadlineError(error)).toBe(true);
    expect((error as ProviderDeadlineError).streaming).toBe(true);
    expect(classifyNetworkError(error).reason).toContain("streaming");
  });
});
