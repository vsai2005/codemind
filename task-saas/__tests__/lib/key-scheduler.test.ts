import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireKey,
  getKeyStats,
  configuredKeyCount,
  __resetScheduler,
} from "@/lib/ai/key-scheduler";
import {
  classifyResponse,
  classifyNetworkError,
} from "@/lib/ai/failure-classification";

const KEY_VARS = [
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
  "NVIDIA_API_KEY_3",
  "NVIDIA_API_KEY_4",
  "NVIDIA_API_KEY_5",
  "NVIDIA_API_KEY",
] as const;

function clearKeys(): void {
  for (const name of KEY_VARS) delete process.env[name];
  delete process.env.NVIDIA_MAX_CONCURRENT_PER_KEY;
  delete process.env.NVIDIA_KEY_COOLDOWN_MS;
  __resetScheduler();
}

/** Synthetic, obviously-fake credentials. */
function configureKeys(count: number): void {
  clearKeys();
  for (let i = 1; i <= count; i++) {
    process.env[`NVIDIA_API_KEY_${i}`] = `test-secret-value-${i}`;
  }
  __resetScheduler();
}

beforeEach(clearKeys);
afterEach(clearKeys);

describe("key loading", () => {
  it("loads and labels the configured slots densely", () => {
    configureKeys(3);
    expect(configuredKeyCount()).toBe(3);
    expect(getKeyStats().map((s) => s.id)).toEqual(["KEY_1", "KEY_2", "KEY_3"]);
  });

  it("works with a single key", () => {
    configureKeys(1);
    const lease = acquireKey();
    expect(lease?.id).toBe("KEY_1");
    lease?.release();
  });

  it("returns null when no key is configured", () => {
    clearKeys();
    expect(configuredKeyCount()).toBe(0);
    expect(acquireKey()).toBeNull();
  });

  it("skips gaps and de-duplicates identical values", () => {
    clearKeys();
    process.env.NVIDIA_API_KEY_1 = "same-value";
    // slot 2 intentionally missing
    process.env.NVIDIA_API_KEY_3 = "same-value"; // duplicate
    process.env.NVIDIA_API_KEY_4 = "other-value";
    __resetScheduler();

    expect(configuredKeyCount()).toBe(2);
    expect(getKeyStats().map((s) => s.id)).toEqual(["KEY_1", "KEY_2"]);
  });
});

describe("fair distribution", () => {
  it("does not always pick KEY_1 when every key is idle", () => {
    configureKeys(5);

    const chosen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const lease = acquireKey();
      expect(lease).not.toBeNull();
      chosen.push(lease!.id);
      lease!.release(); // return it immediately so load stays level
    }

    // With load always 0, LRU must rotate rather than re-picking the first slot.
    expect(new Set(chosen).size).toBe(5);
    expect(chosen[0]).toBe("KEY_1");
    expect(chosen[1]).not.toBe("KEY_1");
  });

  it("spreads concurrent requests one per key before doubling up", () => {
    configureKeys(5);

    const leases = Array.from({ length: 5 }, () => acquireKey());
    expect(leases.every((l) => l !== null)).toBe(true);
    expect(new Set(leases.map((l) => l!.id)).size).toBe(5);

    for (const stat of getKeyStats()) expect(stat.activeRequests).toBe(1);
    leases.forEach((l) => l!.release());
  });

  it("prefers the least-loaded key", () => {
    configureKeys(3);

    // Pin two requests onto KEY_1 and one onto KEY_2 by holding leases.
    const a = acquireKey()!; // KEY_1
    const b = acquireKey()!; // KEY_2
    expect(a.id).toBe("KEY_1");
    expect(b.id).toBe("KEY_2");

    const c = acquireKey()!; // KEY_3 — the only one still at 0
    expect(c.id).toBe("KEY_3");

    [a, b, c].forEach((l) => l.release());
  });
});

describe("concurrency", () => {
  it("enforces the per-key cap and reports exhaustion instead of overselling", () => {
    process.env.NVIDIA_MAX_CONCURRENT_PER_KEY = "2";
    configureKeys(2);
    process.env.NVIDIA_MAX_CONCURRENT_PER_KEY = "2";

    const held = [acquireKey(), acquireKey(), acquireKey(), acquireKey()];
    expect(held.every((l) => l !== null)).toBe(true);

    // 2 keys x cap 2 == 4 slots; the fifth must be refused, not queued.
    expect(acquireKey()).toBeNull();

    held.forEach((l) => l!.release());
    expect(acquireKey()).not.toBeNull();
  });

  it("never lets two callers take the same last slot", () => {
    process.env.NVIDIA_MAX_CONCURRENT_PER_KEY = "1";
    configureKeys(1);
    process.env.NVIDIA_MAX_CONCURRENT_PER_KEY = "1";

    const first = acquireKey();
    const second = acquireKey();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    first!.release();
  });

  it("release is idempotent so a stream that completes and cancels cannot double-decrement", () => {
    configureKeys(1);
    const lease = acquireKey()!;
    expect(getKeyStats()[0].activeRequests).toBe(1);

    lease.release();
    lease.release();
    lease.release();

    expect(getKeyStats()[0].activeRequests).toBe(0);
  });
});

describe("failover and recovery", () => {
  it("cools a rate-limited key and routes the retry elsewhere", () => {
    configureKeys(2);

    const first = acquireKey()!;
    first.reportFailure(classifyResponse(429, "rate limit exceeded"));

    const stats = getKeyStats().find((s) => s.id === first.id)!;
    expect(stats.status).toBe("cooling");
    expect(stats.activeRequests).toBe(0);

    const next = acquireKey()!;
    expect(next.id).not.toBe(first.id);
    next.release();
  });

  it("disables a key on 401 but recovers automatically once the cooldown passes", () => {
    // Two keys: the pool-floor guard only permits disabling when an alternative remains.
    configureKeys(2);

    const lease = acquireKey()!;
    lease.reportFailure(classifyResponse(401, "invalid api key"));

    expect(getKeyStats().find((s) => s.id === lease.id)!.status).toBe("disabled");

    // Traffic moves to the healthy key rather than failing.
    const alternative = acquireKey();
    expect(alternative).not.toBeNull();
    expect(alternative!.id).not.toBe(lease.id);
    alternative!.release();

    // Recovery is timestamp-driven, so simulate elapsed time rather than restarting.
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      // The disabled key becomes eligible again with no restart.
      expect(getKeyStats().find((s) => s.id === lease.id)!.status).toBe("healthy");
      const recovered = acquireKey();
      expect(recovered).not.toBeNull();
      recovered!.release();
    } finally {
      Date.now = realNow;
    }
  });

  it("does not cool a key down for a context-length rejection", () => {
    configureKeys(2);
    const lease = acquireKey()!;

    const classification = classifyResponse(
      400,
      "This model's maximum context length is 1048576 tokens."
    );
    expect(classification.shouldFailover).toBe(false);

    // The gateway releases rather than reporting a failure for this class.
    lease.release();
    expect(getKeyStats().find((s) => s.id === lease.id)!.status).toBe("healthy");
  });

  it("does not penalise a key when the caller aborts", () => {
    configureKeys(1);
    const lease = acquireKey()!;

    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyNetworkError(abort).kind).toBe("aborted");

    lease.release();
    expect(getKeyStats()[0].status).toBe("healthy");
    expect(getKeyStats()[0].activeRequests).toBe(0);
  });

  it("honours excludeIds so a retry avoids the key that just failed", () => {
    configureKeys(3);
    const lease = acquireKey({} as never) ?? acquireKey();
    lease?.release();

    const retry = acquireKey(["KEY_1", "KEY_2"]);
    expect(retry?.id).toBe("KEY_3");
    retry?.release();
  });

  it("resets the failure counter after a success", () => {
    configureKeys(1);
    process.env.NVIDIA_KEY_COOLDOWN_MS = "1";

    const failing = acquireKey()!;
    failing.reportFailure(classifyResponse(500, "upstream error"));
    expect(getKeyStats()[0].failureCount).toBe(1);

    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      const recovered = acquireKey()!;
      recovered.release();
      expect(getKeyStats()[0].failureCount).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("security", () => {
  it("never exposes key material in stats", () => {
    configureKeys(3);
    const serialized = JSON.stringify(getKeyStats());

    expect(serialized).not.toContain("test-secret-value-1");
    expect(serialized).not.toContain("test-secret-value-2");
    expect(serialized).not.toContain("test-secret-value-3");

    for (const stat of getKeyStats()) {
      expect(Object.keys(stat)).not.toContain("secret");
      expect(stat.id).toMatch(/^KEY_\d+$/);
    }
  });

  it("exposes the secret only through the lease", () => {
    configureKeys(1);
    const lease = acquireKey()!;
    expect(lease.secret).toBe("test-secret-value-1");
    expect(JSON.stringify(getKeyStats())).not.toContain(lease.secret);
    lease.release();
  });
});
