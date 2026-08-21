import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireGenerationSlot,
  concurrentGenerationLimit,
  __resetRateLimits,
} from "@/lib/rate-limit";
import { releaseOnStreamEnd } from "@/lib/ai/stream-lifecycle";
import { fetchWithHeaderTimeout } from "@/lib/ai/fetch-timeout";
import { classifyResponse, scrubForLog } from "@/lib/ai/failure-classification";
import { acquireKey, getKeyStats, __resetScheduler } from "@/lib/ai/key-scheduler";

const KEY_VARS = [
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
  "NVIDIA_API_KEY_3",
  "NVIDIA_API_KEY_4",
  "NVIDIA_API_KEY_5",
  "NVIDIA_API_KEY",
] as const;

function configureKeys(count: number): void {
  for (const name of KEY_VARS) delete process.env[name];
  for (let i = 1; i <= count; i++) process.env[`NVIDIA_API_KEY_${i}`] = `secret-${i}`;
  __resetScheduler();
}

beforeEach(() => {
  __resetRateLimits();
  delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
});

afterEach(() => {
  __resetRateLimits();
  for (const name of KEY_VARS) delete process.env[name];
  __resetScheduler();
});

/** Builds a Response whose body streams `chunks` and never completes on its own. */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("per-user generation concurrency (R-1)", () => {
  it("caps concurrent generations per user", () => {
    const limit = concurrentGenerationLimit();
    const held = [];

    for (let i = 0; i < limit; i++) {
      const release = acquireGenerationSlot("user-a");
      expect(release, `slot ${i + 1}`).not.toBeNull();
      held.push(release!);
    }

    // One user must not be able to occupy the pool indefinitely.
    expect(acquireGenerationSlot("user-a")).toBeNull();

    held[0]();
    expect(acquireGenerationSlot("user-a")).not.toBeNull();
  });

  it("isolates users from each other", () => {
    for (let i = 0; i < concurrentGenerationLimit(); i++) acquireGenerationSlot("user-a");

    expect(acquireGenerationSlot("user-a")).toBeNull();
    // A saturated user must not deny service to anyone else.
    expect(acquireGenerationSlot("user-b")).not.toBeNull();
  });

  it("release is idempotent so a stream that completes and cancels cannot over-free", () => {
    const release = acquireGenerationSlot("user-a")!;
    release();
    release();
    release();

    const held = [];
    for (let i = 0; i < concurrentGenerationLimit(); i++) {
      held.push(acquireGenerationSlot("user-a"));
    }
    expect(held.every((r) => r !== null)).toBe(true);
    expect(acquireGenerationSlot("user-a")).toBeNull();
  });
});

describe("stream lifecycle", () => {
  it("releases only after the body is fully consumed, not when the Response is created", async () => {
    let released = false;
    const wrapped = releaseOnStreamEnd(streamingResponse(["a", "b", "c"]), {
      onSettled: () => {
        released = true;
      },
    });

    // Creating the wrapper must not release — this is the bug the whole design exists
    // to avoid, since fetch() resolves long before a generation finishes.
    expect(released).toBe(false);

    await wrapped.text();
    expect(released).toBe(true);
  });

  it("releases when the consumer cancels (browser disconnect)", async () => {
    let released = false;
    const wrapped = releaseOnStreamEnd(streamingResponse(["a", "b"]), {
      onSettled: () => {
        released = true;
      },
    });

    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel("client gone");

    expect(released).toBe(true);
  });

  it("releases exactly once across overlapping terminal paths", async () => {
    let count = 0;
    const wrapped = releaseOnStreamEnd(streamingResponse(["a"]), {
      onSettled: () => {
        count += 1;
      },
    });

    const reader = wrapped.body!.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    await reader.cancel("late cancel after completion");

    expect(count).toBe(1);
  });

  it("releases immediately for a body-less response", () => {
    let released = false;
    releaseOnStreamEnd(new Response(null, { status: 204 }), {
      onSettled: () => {
        released = true;
      },
    });
    expect(released).toBe(true);
  });
});

describe("classification hardening (D-1)", () => {
  it("does not disable a key on 403, which user content can trigger", () => {
    const classification = classifyResponse(403, "content policy violation");

    expect(classification.markUnhealthy).toBe(false);
    expect(classification.shouldFailover).toBe(true);
    expect(classification.cooldownMs).toBeLessThan(60_000);
  });

  it("still disables a key on 401, which user content cannot trigger", () => {
    expect(classifyResponse(401, "invalid api key").markUnhealthy).toBe(true);
  });

  it("never disables the last remaining key", () => {
    configureKeys(1);
    const lease = acquireKey()!;
    lease.reportFailure(classifyResponse(401, "invalid api key"));

    // Parking the only key would black out the whole app; degrade instead.
    expect(getKeyStats()[0].status).not.toBe("disabled");
  });

  it("does disable a bad key when healthy alternatives remain", () => {
    configureKeys(3);
    const lease = acquireKey()!;
    lease.reportFailure(classifyResponse(401, "invalid api key"));

    expect(getKeyStats().find((s) => s.id === lease.id)!.status).toBe("disabled");
  });
});

describe("abandon vs release (R-1 watchdog)", () => {
  it("abandon returns the slot without erasing accumulated backoff", () => {
    configureKeys(2);

    const failing = acquireKey()!;
    failing.reportFailure(classifyResponse(500, "upstream error"));
    const afterFailure = getKeyStats().find((s) => s.id === failing.id)!.failureCount;
    expect(afterFailure).toBe(1);

    const other = acquireKey()!;
    other.abandon();

    // A reclaimed stall is not proof of health, so the counter must survive.
    expect(getKeyStats().find((s) => s.id === failing.id)!.failureCount).toBe(afterFailure);
    expect(getKeyStats().find((s) => s.id === other.id)!.activeRequests).toBe(0);
  });
});

describe("provider header timeout", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("aborts when the provider never sends response headers", async () => {
    // Reproduces a model that is listed by the provider but not actually served:
    // the connection is accepted and then nothing ever arrives.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted: " + String((init.signal as AbortSignal).reason)))
        );
      })) as typeof fetch;

    const started = Date.now();
    await expect(fetchWithHeaderTimeout("https://example.invalid", undefined, 120)).rejects.toThrow();
    // Must give up promptly rather than hanging the caller's request.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops the clock once headers arrive so a slow body can still stream", async () => {
    // The timeout covers only the header phase. A long but healthy generation must
    // not be guillotined mid-stream.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // Emits its first chunk well after the header timeout would have fired.
          await new Promise((r) => setTimeout(r, 150));
          controller.enqueue(new TextEncoder().encode("late-but-valid"));
          controller.close();
        },
      });
      void init;
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;

    const response = await fetchWithHeaderTimeout("https://example.invalid", undefined, 50);
    expect(response.status).toBe(200);

    // Reading finishes after the (now-cleared) timer's deadline.
    await new Promise((r) => setTimeout(r, 120));
    await expect(response.text()).resolves.toBe("late-but-valid");
  });

  it("honours a caller-supplied abort signal", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const controller = new AbortController();
    const promise = fetchWithHeaderTimeout("https://example.invalid", { signal: controller.signal }, 10_000);
    controller.abort();

    await expect(promise).rejects.toThrow();
  });
});

describe("log scrubbing (S-1)", () => {
  it("redacts credentials before truncating", () => {
    const key = `nvapi-${"A".repeat(60)}`;
    const scrubbed = scrubForLog(`upstream said: ${key} rejected`);

    expect(scrubbed).not.toContain("nvapi-");
    expect(scrubbed).not.toContain("A".repeat(20));
  });

  it("redacts bearer headers", () => {
    expect(scrubForLog("Authorization: Bearer supersecretvalue")).not.toContain("supersecretvalue");
  });
});
