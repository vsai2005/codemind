import { describe, it, expect } from "vitest";
import { BODY_LIMITS, enforceBodyLimit } from "@/lib/http/body-limit";
import { MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_REQUEST, MAX_TOTAL_REQUEST_CHARS, chatRequestSchema } from "@/types/chat";

function request(bytes: number | null): Request {
  const headers: Record<string, string> = {};
  if (bytes !== null) headers["content-length"] = String(bytes);
  return new Request("http://localhost/api/chat", { method: "POST", headers });
}

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

  it("keeps the chat transport limit above the schema's character limit", () => {
    // If this inverts, the transport layer starts rejecting payloads the schema would
    // have accepted, and the failure looks like a bug rather than a limit.
    expect(BODY_LIMITS.chat).toBeGreaterThan(MAX_TOTAL_REQUEST_CHARS);
  });
});

describe("chat request aggregate size", () => {
  const user = (content: string) => ({ role: "user" as const, content });

  it("accepts a single large message within the per-message cap", () => {
    const parsed = chatRequestSchema.safeParse({
      messages: [user("x".repeat(MAX_MESSAGE_CHARS))],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects many large messages whose total exceeds the aggregate cap", () => {
    // The defect: 200 messages × 2,000,000 chars each passed every per-field rule while
    // amounting to a 400MB body that req.json() had already allocated.
    const count = Math.ceil(MAX_TOTAL_REQUEST_CHARS / MAX_MESSAGE_CHARS) + 2;
    expect(count).toBeLessThanOrEqual(MAX_MESSAGES_PER_REQUEST);

    const messages = Array.from({ length: count }, () => user("x".repeat(MAX_MESSAGE_CHARS)));
    const parsed = chatRequestSchema.safeParse({ messages });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /character limit/.test(i.message))).toBe(true);
    }
  });

  it("still accepts a realistic long conversation", () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? user("a question about the codebase") : { role: "assistant" as const, content: "y".repeat(4_000) }
    );
    messages.push(user("and one more question"));

    expect(chatRequestSchema.safeParse({ messages }).success).toBe(true);
  });
});
