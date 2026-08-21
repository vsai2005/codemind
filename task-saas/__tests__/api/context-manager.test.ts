import { describe, it, expect, afterEach } from "vitest";
import {
  ContextManager,
  ContextOverflowError,
  getOutputTokenLimit,
  getContextTokenLimit,
  estimateTokens,
  type RetrievalMessage,
} from "@/lib/ai/context-manager";

function restoreEnv(): void {
  delete process.env.AI_CONTEXT_MAX_TOKENS;
  delete process.env.AI_MAX_OUTPUT_TOKENS;
}

afterEach(restoreEnv);

describe("estimateTokens", () => {
  it("uses the prose ratio for ordinary text", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("is more conservative for dense JSON than for prose of the same length", () => {
    const json = '{"a":1,"b":[2,3],"c":{"d":"e"},"f":true,"g":null,"h":[{"i":1}]}'.repeat(20);
    const prose = "the quick brown fox jumps over the lazy dog and keeps running ".repeat(20);

    // Same order of magnitude in characters, but JSON must estimate higher.
    expect(json.length).toBeGreaterThan(prose.length * 0.6);
    expect(estimateTokens(json) / json.length).toBeGreaterThan(estimateTokens(prose) / prose.length);
  });

  it("never estimates below the flat chars/4 baseline", () => {
    // The V2 estimator was chars/4; V3 must not be more optimistic than that anywhere.
    const samples = [
      "plain english sentence here",
      '{"key":"value","n":[1,2,3]}',
      "export const x = (a: number): number => a * 2;",
      "A".repeat(500),
      "aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgY29udGVudA".repeat(10),
    ];
    for (const sample of samples) {
      expect(estimateTokens(sample), sample.slice(0, 24)).toBeGreaterThanOrEqual(
        Math.ceil(sample.length / 4)
      );
    }
  });

  it("treats long unbroken runs as denser than prose", () => {
    const base64ish = "aGVsbG8gd29ybGQ".repeat(40).replace(/\s/g, "");
    expect(estimateTokens(base64ish)).toBeGreaterThan(Math.ceil(base64ish.length / 4));
  });
});

describe("configuration", () => {
  it("loads limits with sane defaults", () => {
    expect(getOutputTokenLimit()).toBeGreaterThan(0);
    expect(getContextTokenLimit()).toBeGreaterThan(0);
  });
});

describe("ContextManager.buildContext", () => {
  it("retains a short conversation in full", () => {
    const historical = [
      { id: "1", role: "user", content: "Hi" },
      { id: "2", role: "assistant", content: "Hello" },
    ];
    const result = ContextManager.buildContext(historical, { id: "3", role: "user", content: "How are you?" } as any, null);

    expect(result.messages.length).toBe(2);
    expect(result.droppedMessageIds).toEqual([]);
    expect(result.droppedMessagesContent).toBe("");
    expect(result.systemPrompt).toContain("You are CodeMind");
    expect(result.pressure.level).toBe("normal");
  });

  it("extracts document attachments and retrieves relevant chunks", () => {
    const historical = [
      {
        id: "1",
        role: "user",
        content: `Attached files<codemind_attachments>{"attachments":[{"type":"document","name":"docs.txt","extractedText":"TypeScript must be used strictly. No any. Also, use SQLite."}]}</codemind_attachments>`,
      },
    ];
    const result = ContextManager.buildContext(historical, { id: "2", role: "user", content: "What database should I use?" } as any, null);

    expect(result.messages[0].content).toBe("Attached files");
    expect(result.systemPrompt).toContain("SQLite");
  });

  describe("coherent turn windowing", () => {
    it("drops whole USER→ASSISTANT turns, never an orphaned half", () => {
      // Sized so the older turn cannot fit but the newer one can.
      process.env.AI_CONTEXT_MAX_TOKENS = "512";
      process.env.AI_MAX_OUTPUT_TOKENS = "100";

      const historical = [
        { id: "u1", role: "user", content: "A".repeat(400) },
        { id: "a1", role: "assistant", content: "B".repeat(400) },
        { id: "u2", role: "user", content: "C".repeat(80) },
        { id: "a2", role: "assistant", content: "D".repeat(80) },
      ];

      const result = ContextManager.buildContext(historical, { id: "u3", role: "user", content: "next" } as any, null);
      const keptIds = result.messages.map((m) => m.id);

      // Whatever survives, no assistant reply may appear without its user message.
      if (keptIds.includes("a1")) expect(keptIds).toContain("u1");
      if (keptIds.includes("a2")) expect(keptIds).toContain("u2");

      // The older, larger turn is the one sacrificed.
      expect(keptIds).toEqual(["u2", "a2"]);
      expect(result.droppedMessageIds).toEqual(["u1", "a1"]);
    });

    it("keeps the retained window contiguous", () => {
      // Sized so the huge middle turn cannot fit, stranding everything older.
      process.env.AI_CONTEXT_MAX_TOKENS = "512";
      process.env.AI_MAX_OUTPUT_TOKENS = "100";

      const historical = [
        { id: "u1", role: "user", content: "tiny" },
        { id: "a1", role: "assistant", content: "tiny" },
        { id: "u2", role: "user", content: "E".repeat(2000) },
        { id: "a2", role: "assistant", content: "F".repeat(200) },
        { id: "u3", role: "user", content: "small" },
        { id: "a3", role: "assistant", content: "small" },
      ];

      const result = ContextManager.buildContext(historical, { id: "u4", role: "user", content: "q" } as any, null);
      const keptIds = result.messages.map((m) => m.id);

      // The huge middle turn cannot fit, so nothing older than it is kept either —
      // V2 would have kept u1/a1 and produced a gap.
      expect(keptIds).toEqual(["u3", "a3"]);
      expect(result.droppedMessageIds).toContain("u1");
      expect(result.droppedMessageIds).toContain("u2");
    });

    it("honours an explicit recent-turn cap", () => {
      const historical = Array.from({ length: 10 }, (_, i) => [
        { id: `u${i}`, role: "user", content: `question ${i}` },
        { id: `a${i}`, role: "assistant", content: `answer ${i}` },
      ]).flat();

      const result = ContextManager.buildContext(historical, { id: "next", role: "user", content: "q" } as any, null, {
        maxRecentTurns: 2,
      });

      expect(result.messages.map((m) => m.id)).toEqual(["u8", "a8", "u9", "a9"]);
    });
  });

  describe("historical conversation retrieval", () => {
    const candidates: RetrievalMessage[] = [
      { id: "old-u", role: "user", content: "Which database should this project use?" },
      {
        id: "old-a",
        role: "assistant",
        content:
          "We decided to use PostgreSQL with Prisma because we need relational integrity and migrations.",
      },
      { id: "chit-u", role: "user", content: "thanks" },
      { id: "chit-a", role: "assistant", content: "you're welcome" },
    ];

    it("surfaces an older decision that is no longer in the recent window", () => {
      const result = ContextManager.buildContext([], { id: "n", role: "user", content: "Why did we choose PostgreSQL?" } as any, null, {
        retrievalCandidates: candidates,
      });

      expect(result.systemPrompt).toContain("RELEVANT EARLIER CONVERSATION");
      expect(result.systemPrompt).toContain("PostgreSQL with Prisma");
      expect(result.retrievedMessageIds).toContain("old-a");
    });

    it("keeps the retrieved unit as a USER + ASSISTANT pair", () => {
      const result = ContextManager.buildContext([], { id: "n", role: "user", content: "Why did we choose PostgreSQL?" } as any, null, {
        retrievalCandidates: candidates,
      });

      expect(result.retrievedMessageIds).toContain("old-u");
      expect(result.retrievedMessageIds).toContain("old-a");
    });

    it("does not retrieve turns already visible in the recent window", () => {
      const historical = [
        { id: "old-u", role: "user", content: "Which database should this project use?" },
        { id: "old-a", role: "assistant", content: "We decided to use PostgreSQL with Prisma because…" },
      ];

      const result = ContextManager.buildContext(historical, { id: "n", role: "user", content: "Why did we choose PostgreSQL?" } as any, null, {
        retrievalCandidates: candidates,
      });

      expect(result.messages.map((m) => m.id)).toContain("old-a");
      expect(result.retrievedMessageIds).not.toContain("old-a");
    });

    it("ignores irrelevant history", () => {
      const result = ContextManager.buildContext([], { id: "n", role: "user", content: "Explain CSS grid layout" } as any, null, {
        retrievalCandidates: candidates,
      });

      expect(result.systemPrompt).not.toContain("RELEVANT EARLIER CONVERSATION");
      expect(result.retrievedMessageIds).toEqual([]);
    });

    it("adds nothing when there are no candidates", () => {
      const result = ContextManager.buildContext([], { id: "n", role: "user", content: "Why PostgreSQL?" } as any, null);
      expect(result.retrievedMessageIds).toEqual([]);
    });
  });

  describe("budget and pressure", () => {
    it("reserves extra headroom for image requests", () => {
      const withoutImage = ContextManager.buildContext([], { id: "n", role: "user", content: "hi" } as any, null);
      const withImage = ContextManager.buildContext([], { id: "n", role: "user", content: "hi" } as any, null, {
        hasImage: true,
      });

      expect(withImage.pressure.total).toBeLessThan(withoutImage.pressure.total);
    });

    it("reports a pressure level and ratio", () => {
      const result = ContextManager.buildContext([], { id: "n", role: "user", content: "hi" } as any, null);
      expect(result.pressure.ratio).toBeGreaterThanOrEqual(0);
      expect(["normal", "elevated", "high", "critical"]).toContain(result.pressure.level);
    });

    it("keeps summary, retrieval and history inside one shared budget", () => {
      process.env.AI_CONTEXT_MAX_TOKENS = "20000";
      process.env.AI_MAX_OUTPUT_TOKENS = "1000";

      const historical = Array.from({ length: 40 }, (_, i) => [
        { id: `u${i}`, role: "user", content: `question about architecture ${i} `.repeat(20) },
        { id: `a${i}`, role: "assistant", content: `we decided because ${i} `.repeat(20) },
      ]).flat();

      const result = ContextManager.buildContext(
        historical,
        { id: "n", role: "user", content: "architecture decision" } as any,
        "Earlier we discussed architecture at length. ".repeat(50),
        { retrievalCandidates: historical.map((m) => ({ id: m.id, role: m.role, content: m.content })) }
      );

      // Everything actually handed to the model must fit the accounted budget.
      expect(result.pressure.used).toBeLessThanOrEqual(result.pressure.total);
      expect(result.pressure.ratio).toBeLessThanOrEqual(1);
    });
  });

  describe("current message priority", () => {
    it("throws a typed, explanatory error instead of truncating", () => {
      process.env.AI_CONTEXT_MAX_TOKENS = "400";

      let caught: unknown;
      try {
        ContextManager.buildContext([], { id: "1", role: "user", content: "A".repeat(50000) } as any, null);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ContextOverflowError);
      const err = caught as ContextOverflowError;
      expect(err.message).toMatch(/too large for the model's context window/i);
      expect(err.message).toMatch(/not been truncated/i);
      expect(err.requiredTokens).toBeGreaterThan(err.availableTokens);
    });

    it("always keeps the current request even under heavy pressure", () => {
      process.env.AI_CONTEXT_MAX_TOKENS = "3000";
      process.env.AI_MAX_OUTPUT_TOKENS = "200";

      const historical = Array.from({ length: 30 }, (_, i) => [
        { id: `u${i}`, role: "user", content: "G".repeat(300) },
        { id: `a${i}`, role: "assistant", content: "H".repeat(300) },
      ]).flat();

      const result = ContextManager.buildContext(historical, { id: "n", role: "user", content: "the current question" } as any, null);

      // History is sacrificed, never the current request.
      expect(result.droppedMessageIds.length).toBeGreaterThan(0);
      expect(result.pressure.used).toBeLessThanOrEqual(result.pressure.total);
    });
  });
});
