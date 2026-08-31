import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const findFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { conversation: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

import { GET } from "@/app/api/conversations/[id]/route";
import {
  isGenerationPending,
  GENERATION_SLOT_MAX_LIFETIME_MS,
} from "@/lib/ai/generation-window";
import { auth } from "@/auth";

/**
 * "A reply is still being written."
 *
 * WHY THIS SIGNAL EXISTS
 * A generation outlives its reader. Switching conversations mid-answer detaches the
 * stream rather than cancelling it (lib/ai/stream-lifecycle.ts), so the reply keeps
 * being written and is persisted when it lands. Server-side that already worked — what
 * was missing was any way for the page to know, so coming back mid-answer showed a
 * conversation that looked dead until the user reloaded by hand.
 *
 * WHY IT IS DERIVED AND NOT STORED
 * The user's message is persisted BEFORE generation starts, so a trailing user turn is
 * exactly the in-flight state. No new table, no registry to keep in sync, and it
 * survives a process restart — which an in-memory flag would not.
 *
 * THE HONEST LIMITATION, which these tests pin down: a crash also leaves a trailing
 * user message. Nothing in the row distinguishes "still running" from "died". Bounding
 * the claim by the generation lifetime is what keeps the wrong answer cheap — a dead
 * turn claims to be working for at most five minutes instead of forever.
 */
describe("generation pending signal", () => {
  const NOW = new Date("2026-08-31T14:00:00.000Z").getTime();
  const ago = (ms: number): Date => new Date(NOW - ms);

  describe("isGenerationPending", () => {
    it("is true for a user message still inside the generation window", () => {
      expect(isGenerationPending("user", ago(30_000), NOW)).toBe(true);
    });

    it("is false once the window has passed, so a crashed turn stops claiming to run", () => {
      expect(
        isGenerationPending("user", ago(GENERATION_SLOT_MAX_LIFETIME_MS + 1), NOW)
      ).toBe(false);
    });

    it("is false when the last message is the assistant's — the reply already landed", () => {
      expect(isGenerationPending("assistant", ago(1_000), NOW)).toBe(false);
    });

    it("is false for an empty conversation", () => {
      expect(isGenerationPending(null, null, NOW)).toBe(false);
    });

    it("treats clock skew as live rather than dead", () => {
      // A row timestamped slightly in the future is a clock disagreement, not a
      // generation that has not started. Calling it dead would hide a real reply.
      expect(isGenerationPending("user", new Date(NOW + 5_000), NOW)).toBe(true);
    });

    it("covers a Kimi-length turn, which is the case that made this window matter", () => {
      // ~3 minutes of queue before the first token. A window shorter than the slowest
      // real generation would declare a live turn dead while it was still running.
      expect(isGenerationPending("user", ago(3 * 60_000), NOW)).toBe(true);
    });
  });

  describe("conversation endpoint", () => {
    beforeEach(() => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.clearAllMocks();
    });

    const req = new Request("http://localhost:3000/api/conversations/conv_1");
    const params = { params: { id: "conv_1" } };

    it("reports pendingSince when the last message is an unanswered user turn", async () => {
      const createdAt = ago(20_000);
      findFirst.mockResolvedValue({
        id: "conv_1",
        messages: [
          { id: "m1", role: "user", content: "hi", createdAt: ago(60_000), artifacts: [] },
          { id: "m2", role: "assistant", content: "hello", createdAt: ago(50_000), artifacts: [] },
          { id: "m3", role: "user", content: "and again", createdAt, artifacts: [] },
        ],
      });

      const body = await (await GET(req, params)).json();

      expect(body.pendingSince).toBe(createdAt.toISOString());
    });

    it("reports null once the reply has landed", async () => {
      findFirst.mockResolvedValue({
        id: "conv_1",
        messages: [
          { id: "m1", role: "user", content: "hi", createdAt: ago(20_000), artifacts: [] },
          { id: "m2", role: "assistant", content: "hello", createdAt: ago(1_000), artifacts: [] },
        ],
      });

      const body = await (await GET(req, params)).json();

      // This is what stops the client polling: the answer is here, nothing is pending.
      expect(body.pendingSince).toBeNull();
    });

    it("reports null for a turn old enough to be abandoned", async () => {
      findFirst.mockResolvedValue({
        id: "conv_1",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hi",
            createdAt: ago(GENERATION_SLOT_MAX_LIFETIME_MS + 60_000),
            artifacts: [],
          },
        ],
      });

      const body = await (await GET(req, params)).json();

      expect(body.pendingSince).toBeNull();
    });

    it("still returns the messages themselves", async () => {
      // The signal is additive. Breaking the existing payload to add it would take the
      // conversation down with it.
      findFirst.mockResolvedValue({
        id: "conv_1",
        messages: [
          { id: "m1", role: "user", content: "hi", createdAt: ago(20_000), artifacts: [] },
        ],
      });

      const body = await (await GET(req, params)).json();

      expect(body.id).toBe("conv_1");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe("hi");
    });

    it("refuses an unauthenticated request", async () => {
      vi.mocked(auth).mockResolvedValue(null as never);
      expect((await GET(req, params)).status).toBe(401);
    });
  });
});
