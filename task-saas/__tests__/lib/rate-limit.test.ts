import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkRateLimit,
  enforceRateLimit,
  identifyRequester,
  rateLimitResponse,
  RATE_LIMITS,
  __resetRateLimits,
} from "@/lib/rate-limit";

describe("rate limiter", () => {
  beforeEach(() => {
    __resetRateLimits();
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
  });

  afterEach(() => {
    __resetRateLimits();
    delete process.env.CODEMIND_DISABLE_RATE_LIMIT;
  });

  it("allows requests up to the limit and blocks the next one", () => {
    const limit = RATE_LIMITS.chat.limit;

    for (let i = 0; i < limit; i++) {
      expect(checkRateLimit("chat", "user:a").ok, `request ${i + 1}`).toBe(true);
    }

    const blocked = checkRateLimit("chat", "user:a");
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isolates identities from each other", () => {
    for (let i = 0; i < RATE_LIMITS.chat.limit; i++) checkRateLimit("chat", "user:a");

    expect(checkRateLimit("chat", "user:a").ok).toBe(false);
    expect(checkRateLimit("chat", "user:b").ok).toBe(true);
  });

  it("isolates buckets from each other", () => {
    for (let i = 0; i < RATE_LIMITS.chat.limit; i++) checkRateLimit("chat", "user:a");

    expect(checkRateLimit("chat", "user:a").ok).toBe(false);
    expect(checkRateLimit("upload", "user:a").ok).toBe(true);
  });

  it("resets after the window elapses", () => {
    const start = Date.now();
    for (let i = 0; i < RATE_LIMITS.chat.limit; i++) checkRateLimit("chat", "user:a", start);
    expect(checkRateLimit("chat", "user:a", start).ok).toBe(false);

    const afterWindow = start + RATE_LIMITS.chat.windowMs + 1;
    expect(checkRateLimit("chat", "user:a", afterWindow).ok).toBe(true);
  });

  it("can be disabled for local development", () => {
    process.env.CODEMIND_DISABLE_RATE_LIMIT = "true";
    for (let i = 0; i < RATE_LIMITS.chat.limit + 50; i++) {
      expect(checkRateLimit("chat", "user:a").ok).toBe(true);
    }
  });

  it("returns a 429 with Retry-After when tripped", async () => {
    const request = new Request("http://localhost/api/chat", { method: "POST" });
    for (let i = 0; i < RATE_LIMITS.chat.limit; i++) enforceRateLimit("chat", request, "u1");

    const response = enforceRateLimit("chat", request, "u1");
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBeTruthy();
    expect(response?.headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.chat.limit));

    const body = await response?.json();
    expect(body.error).toMatch(/Rate limit/);
  });

  it("returns null while under the limit", () => {
    const request = new Request("http://localhost/api/chat", { method: "POST" });
    expect(enforceRateLimit("chat", request, "u1")).toBeNull();
  });

  it("prefers the user id over the client IP", () => {
    const request = new Request("http://localhost/api/chat", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });

    expect(identifyRequester(request, "user-123")).toBe("user:user-123");
    expect(identifyRequester(request, null)).toBe("ip:203.0.113.9");
    expect(identifyRequester(new Request("http://localhost/"), null)).toBe("ip:unknown");
  });

  it("exposes a 429 response shape independent of enforcement", async () => {
    const response = rateLimitResponse({
      ok: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfterSeconds: 30,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });
});
