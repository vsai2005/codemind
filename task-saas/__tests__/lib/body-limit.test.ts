import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BODY_LIMITS, bodyLimitBytes, enforceBodyLimit } from "@/lib/http/body-limit";
import {
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES_PER_REQUEST,
  getTotalRequestChars,
  chatRequestSchema,
} from "@/types/chat";
import { HTTP_LIMIT_BOUNDS, HTTP_LIMIT_DEFAULTS, getChatBodyLimitBytes } from "@/lib/env";

function request(bytes: number | null): Request {
  const headers: Record<string, string> = {};
  if (bytes !== null) headers["content-length"] = String(bytes);
  return new Request("http://localhost/api/chat", { method: "POST", headers });
}

const HTTP_VARS = ["CODEMIND_CHAT_BODY_MAX_BYTES", "CODEMIND_REQUEST_MAX_CHARS"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of HTTP_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of HTTP_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("enforceBodyLimit", () => {
  it("allows a body at the limit", () => {
    expect(enforceBodyLimit(request(BODY_LIMITS.json), "json")).toBeNull();
  });

  it("rejects a body over the limit with 413, before it is read", () => {
    const response = enforceBodyLimit(request(BODY_LIMITS.json + 1), "json");
    expect(response).not.toBeNull();
    expect(response?.status).toBe(413);
  });

  it("names the limit in the error without exposing internals", async () => {
    const response = enforceBodyLimit(request(BODY_LIMITS.upload * 4), "upload");
    const body = (await response?.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
    expect(body.error).toMatch(/12MB/);
  });

  it("allows a request with no declared length through to schema validation", () => {
    // Chunked transfer cannot be pre-checked; the schema is the backstop.
    expect(enforceBodyLimit(request(null), "json")).toBeNull();
  });

  it("ignores a malformed content-length rather than rejecting a valid request", () => {
    const malformed = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
    });
    expect(enforceBodyLimit(malformed, "json")).toBeNull();
  });
});

describe("configurable chat body limit", () => {
  it("defaults to the value sized for a 512MB instance", () => {
    expect(bodyLimitBytes("chat")).toBe(HTTP_LIMIT_DEFAULTS.chatBodyBytes);
    expect(bodyLimitBytes("chat")).toBe(20 * 1024 * 1024);
  });

  it("is raised by the environment without a code change", () => {
    process.env.CODEMIND_CHAT_BODY_MAX_BYTES = String(64 * 1024 * 1024);
    expect(bodyLimitBytes("chat")).toBe(64 * 1024 * 1024);
    // And the guard actually honours the raised value.
    expect(enforceBodyLimit(request(48 * 1024 * 1024), "chat")).toBeNull();
  });

  it("is read per call, so a change takes effect without a rebuild", () => {
    expect(bodyLimitBytes("chat")).toBe(HTTP_LIMIT_DEFAULTS.chatBodyBytes);
    process.env.CODEMIND_CHAT_BODY_MAX_BYTES = String(32 * 1024 * 1024);
    expect(bodyLimitBytes("chat")).toBe(32 * 1024 * 1024);
  });

  it("clamps an absurd value rather than trusting it", () => {
    process.env.CODEMIND_CHAT_BODY_MAX_BYTES = String(4 * 1024 * 1024 * 1024);
    expect(getChatBodyLimitBytes()).toBe(HTTP_LIMIT_BOUNDS.chatBodyBytes.max);
  });

  it("falls back to the default on a non-numeric value", () => {
    process.env.CODEMIND_CHAT_BODY_MAX_BYTES = "twenty megabytes";
    expect(getChatBodyLimitBytes()).toBe(HTTP_LIMIT_DEFAULTS.chatBodyBytes);
  });

  it("leaves the fixed limits alone", () => {
    process.env.CODEMIND_CHAT_BODY_MAX_BYTES = String(64 * 1024 * 1024);
    expect(bodyLimitBytes("upload")).toBe(BODY_LIMITS.upload);
    expect(bodyLimitBytes("json")).toBe(BODY_LIMITS.json);
    expect(bodyLimitBytes("projectSettings")).toBe(BODY_LIMITS.projectSettings);
  });
});

describe("chat request aggregate size", () => {
  const user = (content: string) => ({ role: "user" as const, content });

  it("defaults to the value sized for a 512MB instance", () => {
    expect(getTotalRequestChars()).toBe(HTTP_LIMIT_DEFAULTS.totalRequestChars);
    expect(getTotalRequestChars()).toBe(16_000_000);
  });

  it("keeps the transport limit above the character limit by default", () => {
    // If this inverts, the transport layer starts rejecting payloads the schema would
    // have accepted, and the failure looks like a bug rather than a limit.
    expect(bodyLimitBytes("chat")).toBeGreaterThan(getTotalRequestChars());
  });

  it("accepts a single large message within the per-message cap", () => {
    const parsed = chatRequestSchema.safeParse({
      messages: [user("x".repeat(MAX_MESSAGE_CHARS))],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects many large messages whose total exceeds the aggregate cap", () => {
    // The defect: 200 messages x 2,000,000 chars each passed every per-field rule while
    // amounting to a body req.json() had already allocated.
    const count = Math.ceil(getTotalRequestChars() / MAX_MESSAGE_CHARS) + 2;
    expect(count).toBeLessThanOrEqual(MAX_MESSAGES_PER_REQUEST);

    const messages = Array.from({ length: count }, () => user("x".repeat(MAX_MESSAGE_CHARS)));
    const parsed = chatRequestSchema.safeParse({ messages });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /character limit/.test(i.message))).toBe(true);
    }
  });

  it("quotes the limit actually in force, not a value baked in at build time", () => {
    process.env.CODEMIND_REQUEST_MAX_CHARS = "5000000";
    const messages = Array.from({ length: 4 }, () => user("x".repeat(MAX_MESSAGE_CHARS)));
    const parsed = chatRequestSchema.safeParse({ messages });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("5,000,000"))).toBe(true);
    }
  });

  it("accepts a payload the raised limit permits", () => {
    // 8 x 2M = 16M chars: over the default, under the configured value.
    process.env.CODEMIND_REQUEST_MAX_CHARS = "40000000";
    const messages = Array.from({ length: 8 }, () => user("x".repeat(MAX_MESSAGE_CHARS)));
    expect(chatRequestSchema.safeParse({ messages }).success).toBe(true);
  });

  it("still accepts a realistic long conversation", () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0
        ? user("a question about the codebase")
        : { role: "assistant" as const, content: "y".repeat(4_000) }
    );
    messages.push(user("and one more question"));

    expect(chatRequestSchema.safeParse({ messages }).success).toBe(true);
  });

  it("leaves room for a full 512K-token message plus a 10MB image at the default", () => {
    // The two payloads the default was sized around, together.
    const fullContextMessage = MAX_MESSAGE_CHARS; // ~2,000,000
    const base64Image = Math.ceil((10 * 1024 * 1024 * 4) / 3); // ~14,000,000
    expect(fullContextMessage + base64Image).toBeLessThanOrEqual(getTotalRequestChars());
  });
});
