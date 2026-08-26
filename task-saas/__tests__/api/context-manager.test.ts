import { describe, it, expect, afterEach } from "vitest";
import {
  ContextManager,
  ContextOverflowError,
  getOutputTokenLimit,
  getContextTokenLimit,
  estimateTokens,
  type RetrievalMessage,
} from "@/lib/ai/context-manager";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";

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
      // Sized so the older turn cannot fit but the newer one can — the window has
      // to clear the system prompt + output + margin before any history fits.
      //
      // This figure no longer tracks a constant. buildContext now subtracts the
      // prompt it actually assembles, which depends on the user message: "q"
      // mentions no file, so the artifact rules are dropped and the prompt costs
      // 203 rather than the 494 worst case. Change that message to something
      // mentioning a file and the budget shrinks by ~177 tokens under this test's
      // feet. The assertions below fail loudly if that happens, which is why the
      // literal is safe to keep.
      process.env.AI_CONTEXT_MAX_TOKENS = "417";
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
      process.env.AI_CONTEXT_MAX_TOKENS = "417";
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

  describe("system prompt guardrails", () => {
    const promptFor = () =>
      ContextManager.buildContext([], { id: "1", role: "user", content: "make me a pdf" } as any, null)
        .systemPrompt;

    /**
     * Asked for a PDF on the plain chat path, the model invented a tool it does not
     * have and streamed {"tool": "write_code", "arguments": {...}} into the reply,
     * exhausting its output budget on escaped JSON. Forbidding artifact XML was not
     * enough - the prohibition has to name tool-call syntax explicitly.
     */
    it("states that no tools are available", () => {
      expect(promptFor()).toMatch(/no tools/i);
    });

    it("forbids tool-call and function-call syntax by name", () => {
      const prompt = promptFor();
      expect(prompt).toMatch(/tool-call or function-call syntax/i);
      expect(prompt).toContain('{"tool": ...}');
      expect(prompt).toContain('{"name": ..., "arguments": ...}');
    });

    it("still forbids artifact markup", () => {
      const prompt = promptFor();
      expect(prompt).toContain("<codemind_artifact>");
      expect(prompt).toContain('<file path="..."');
    });

    it("tells the model what to do instead of inventing a mechanism", () => {
      expect(promptFor()).toMatch(/fenced Markdown block/i);
    });

    /**
     * The opposite failure, caused by the first fix. Told flatly that it "cannot
     * create a file", the model started answering "I can't create a PDF" - false
     * about the product, since the artifact pipeline builds them. The prompt has to
     * separate what the MODEL cannot do from what CODEMIND can.
     */
    it("does not claim the product cannot produce downloads", () => {
      // Matched on meaning rather than exact wording: this paragraph has been
      // rewritten three times, once per failure mode, and a brittle string match
      // fails on rewording instead of on regression.
      const prompt = promptFor();
      expect(prompt).toMatch(/codemind can produce downloads/i);
      expect(prompt).toMatch(/never say a download cannot be created/i);
    });

    it("contains no blanket statement that a file cannot be created", () => {
      // The exact phrasing that produced the refusal.
      expect(promptFor()).not.toMatch(/you cannot .{0,20}create a file/i);
    });

    /**
     * The third failure, produced by fixing the second. Told the pipeline exists, the
     * model narrated as though it were running - "the server-side pipeline will now
     * package it, you'll receive the download shortly" - and no file ever arrived.
     *
     * The model cannot otherwise know this: intent detection runs in the route BEFORE
     * it is called, so a chat reply existing at all means the pipeline declined.
     */
    it("forbids promising a download that is not coming", () => {
      const prompt = promptFor();
      expect(prompt).toMatch(/never say a download is being created/i);
      expect(prompt).toMatch(/on its way|will arrive shortly/i);
    });

    it("explains why no download is coming, not just that it is not", () => {
      // Without the reason the instruction is arbitrary and the model drifts back.
      expect(promptFor()).toMatch(/already decided this was not a download request/i);
    });

    it("routes the user to the phrasing that does reach the pipeline", () => {
      expect(promptFor()).toMatch(/give me this as a PDF/i);
    });

    /**
     * The saving from conditional layers has to reach the CONVERSATION, not just the
     * prompt string.
     *
     * While the budget subtracted a fixed worst-case reserve, making layers optional
     * shrank the prompt and changed nothing else: a plain question built a 203-token
     * prompt and was still charged 494. This asserts the two now move together.
     */
    it("gives a plain question a larger conversation budget than a repo+file turn", () => {
      process.env.AI_CONTEXT_MAX_TOKENS = "50000";
      process.env.AI_MAX_OUTPUT_TOKENS = "1000";

      const plain = ContextManager.buildContext(
        [],
        { id: "p", role: "user", content: "why is my test failing" } as any,
        null
      );

      const repoAndFile = ContextManager.buildContext(
        [],
        { id: "r", role: "user", content: "give me session.ts as a pdf" } as any,
        null,
        { repositoryFiles: [{ path: "src/session.ts", content: "export const a = 1;" }] }
      );

      expect(plain.pressure.total).toBeGreaterThan(repoAndFile.pressure.total);
    });

    /**
     * The optimistic-reservation direction, pinned.
     *
     * The grounding layer is reserved from the INPUT file list, before budgeting, but
     * assembled from the RENDERED block, after it. When files are supplied and every
     * one is priced out, the two disagree — and the disagreement has to fall on the
     * over-reserve side. Over-reserving costs a slightly smaller conversation; under-
     * reserving builds a prompt larger than the window was sized for, which is the
     * failure this whole budget exists to prevent.
     *
     * Nothing in the types enforces the direction, so it is asserted here. If a future
     * change inverts it — reserving from the rendered block, or assembling from the
     * input list — this goes red rather than shipping a window that can overflow.
     */
    it("over-reserves rather than under-reserves when repository files are priced out", () => {
      const maxContext = 900;
      const maxOutput = 100;
      process.env.AI_CONTEXT_MAX_TOKENS = String(maxContext);
      process.env.AI_MAX_OUTPUT_TOKENS = String(maxOutput);

      // Large enough that nothing is left for the repository block once the message is
      // paid for, small enough not to overflow the window on its own.
      const message = "z".repeat(1300);

      const result = ContextManager.buildContext(
        [],
        { id: "n", role: "user", content: message } as any,
        null,
        { repositoryFiles: [{ path: "src/session.ts", content: "export function createSession() { return 1; }" }] }
      );

      // Preconditions. Without these the assertion below is vacuous: it would be
      // comparing a reserve against an assembly that happened to agree with it.
      expect(result.contextBlocks).not.toContain("--- REPOSITORY FILES ---");
      expect(result.systemPrompt).not.toContain("Cite a path only");

      // What buildContext charged: everything the window lost that was not output,
      // safety margin, or the conversation itself.
      const safetyMargin = Math.ceil(maxContext * 0.02);
      const charged = maxContext - maxOutput - safetyMargin - result.pressure.total;

      // What the prompt actually cost, grounding excluded because it was not rendered.
      // "z" repeated mentions no file, so the artifact rules are off in both figures.
      const assembled = estimateTokens(
        buildSystemPrompt({ hasRepositoryContext: false, includeArtifactRules: false })
      );

      expect(charged).toBeGreaterThanOrEqual(assembled);

      // And specifically by the grounding layer — proving the gap is the reservation
      // being optimistic, not some unrelated slack that happens to be positive.
      const withGrounding = estimateTokens(
        buildSystemPrompt({ hasRepositoryContext: true, includeArtifactRules: false })
      );
      expect(charged).toBe(withGrounding);
    });

    it("fits inside the reserve the budget subtracts for it", () => {
      // Under-reserving surfaces as an occasional context overflow rather than an
      // obvious error, so this guards the number rather than trusting it.
      expect(estimateTokens(promptFor())).toBeLessThanOrEqual(400);
    });
  });

  describe("project workspace context", () => {
    /**
     * The defect: project instructions and memory were capped at a share of the TOTAL
     * budget but never against what actually remained. When the current message had
     * already consumed most of the window both blocks were still added at full size,
     * driving the running budget negative and pushing the assembled prompt past the
     * configured context limit.
     */
    it("does not exceed the budget when the current message has consumed it", () => {
      process.env.AI_CONTEXT_MAX_TOKENS = "3750";
      process.env.AI_MAX_OUTPUT_TOKENS = "200";

      // Sized so the message fits (≈3,234 of a ≈3,317-token budget) but leaves LESS
      // than the 5% ratio cap. That is the shape that broke: a remainder smaller than
      // the share each block was allowed to claim. A message that merely fits with room
      // to spare would pass under the old logic too and prove nothing.
      const nearlyFull = "Q".repeat(9_700);

      const result = ContextManager.buildContext(
        [],
        { id: "n", role: "user", content: nearlyFull } as any,
        null,
        {
          projectInstructions: "I".repeat(20_000),
          projectMemory: [
            { title: "Stack", items: Array.from({ length: 40 }, () => "M".repeat(400)) },
          ],
        }
      );

      /**
       * The premise, asserted rather than described.
       *
       * This scenario only means anything while the room left after the message is
       * SMALLER than the share each block is allowed to claim — that mismatch is the
       * bug it was written for. When buildContext started subtracting the measured
       * prompt instead of a fixed reserve, the budget grew by ~317 tokens and the
       * remainder quietly became larger than the cap: every assertion below still
       * passed, against a scenario that no longer reproduced anything.
       *
       * Checking the premise means the next change to prompt size fails here loudly
       * instead of hollowing the test out in silence.
       */
      const remainder = result.pressure.total - estimateTokens(nearlyFull);
      expect(remainder).toBeGreaterThan(0); // the message still fits
      expect(remainder).toBeLessThan(Math.floor(result.pressure.total * 0.05));

      expect(result.pressure.used).toBeLessThanOrEqual(result.pressure.total);
      expect(
        estimateTokens(result.contextBlocks) + estimateTokens(nearlyFull)
      ).toBeLessThanOrEqual(result.pressure.total);
    });

    it("still injects project context when there is room for it", () => {
      process.env.AI_CONTEXT_MAX_TOKENS = "50000";
      process.env.AI_MAX_OUTPUT_TOKENS = "1000";

      const result = ContextManager.buildContext(
        [],
        { id: "n", role: "user", content: "how do we handle migrations here?" } as any,
        null,
        {
          projectInstructions: "Always use forward-only migrations.",
          projectMemory: [{ title: "Stack", items: ["PostgreSQL", "Prisma"] }],
        }
      );

      expect(result.contextBlocks).toContain("PROJECT INSTRUCTIONS");
      expect(result.contextBlocks).toContain("forward-only migrations");
      expect(result.contextBlocks).toContain("PROJECT MEMORY");
      expect(result.contextBlocks).toContain("PostgreSQL");
      expect(result.pressure.used).toBeLessThanOrEqual(result.pressure.total);
    });
  });
});
