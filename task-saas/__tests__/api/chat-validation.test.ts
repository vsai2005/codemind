import { describe, it, expect } from "vitest";
import {
  chatRequestSchema,
  attachmentBlockSchema,
  formatIssues,
  MAX_MESSAGES_PER_REQUEST,
  MAX_MESSAGE_CHARS,
} from "@/types/chat";

const validRequest = {
  messages: [{ id: "m1", role: "user", content: "Hello" }],
};

describe("chatRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    expect(chatRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("accepts an optional conversationId and ignores unknown fields", () => {
    const parsed = chatRequestSchema.safeParse({
      ...validRequest,
      conversationId: "clx1234567890abcdef",
      // useChat sends extra fields; they must be stripped, not rejected.
      extraneous: { nested: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("extraneous" in parsed.data).toBe(false);
  });

  it("rejects an empty or missing message list", () => {
    expect(chatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({}).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: "nope" }).success).toBe(false);
  });

  it("requires the final message to come from the user", () => {
    const parsed = chatRequestSchema.safeParse({
      messages: [{ role: "assistant", content: "I am the last message" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(formatIssues(parsed.error)).toMatch(/last message/);
  });

  it("rejects unknown roles", () => {
    expect(
      chatRequestSchema.safeParse({ messages: [{ role: "root", content: "hi" }] }).success
    ).toBe(false);
  });

  it("rejects non-string content", () => {
    expect(
      chatRequestSchema.safeParse({ messages: [{ role: "user", content: { evil: true } }] }).success
    ).toBe(false);
  });

  it("caps message count and message size", () => {
    const tooMany = Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, () => ({
      role: "user" as const,
      content: "hi",
    }));
    expect(chatRequestSchema.safeParse({ messages: tooMany }).success).toBe(false);

    const tooLong = [{ role: "user" as const, content: "x".repeat(MAX_MESSAGE_CHARS + 1) }];
    expect(chatRequestSchema.safeParse({ messages: tooLong }).success).toBe(false);
  });

  it("rejects a conversationId that is not an identifier", () => {
    for (const id of ["../../etc", "a b", "'; DROP TABLE", "x".repeat(100)]) {
      expect(
        chatRequestSchema.safeParse({ ...validRequest, conversationId: id }).success,
        id
      ).toBe(false);
    }
  });
});

describe("attachmentBlockSchema", () => {
  it("accepts image and document attachments", () => {
    const parsed = attachmentBlockSchema.safeParse({
      attachments: [
        { type: "image", name: "a.png", url: "data:image/png;base64,AAAA" },
        { type: "document", name: "b.txt", extractedText: "hello" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown attachment types", () => {
    expect(
      attachmentBlockSchema.safeParse({ attachments: [{ type: "executable", url: "x" }] }).success
    ).toBe(false);
  });

  it("rejects an image attachment with no url", () => {
    expect(
      attachmentBlockSchema.safeParse({ attachments: [{ type: "image", name: "a.png" }] }).success
    ).toBe(false);
  });

  it("caps the number of attachments", () => {
    const many = Array.from({ length: 20 }, () => ({
      type: "document" as const,
      extractedText: "x",
    }));
    expect(attachmentBlockSchema.safeParse({ attachments: many }).success).toBe(false);
  });
});
