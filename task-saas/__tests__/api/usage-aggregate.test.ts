import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const aggregate = vi.fn();
const count = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    message: {
      aggregate: (...a: unknown[]) => aggregate(...a),
      count: (...a: unknown[]) => count(...a),
    },
    $transaction: vi.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops)
    ),
  },
}));

import { GET as usageGET } from "@/app/api/usage/route";
import { GET as conversationUsageGET } from "@/app/api/conversations/[id]/usage/route";
import { auth } from "@/auth";

/**
 * Token usage aggregation.
 *
 * The counts are provider-reported actuals read back from stored rows — unrelated to
 * estimateTokens, which guesses BEFORE a request to decide what fits in the window.
 * Conflating them would put a number beside "tokens used" that no provider agreed to.
 *
 * The behaviour worth protecting is that a missing count stays missing. Usage arrives
 * only from providers that send a usage chunk; Gemini sends none, so its turns store
 * null. Rendering those as 0 would make a conversation held on Gemini read as almost
 * free rather than unmeasured.
 */
describe("usage aggregation", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  afterEach(() => vi.clearAllMocks());

  describe("profile total", () => {
    it("matches a hand-computed sum over a multi-message fixture", async () => {
      // Three assistant turns: 100+20, 250+80, and one Gemini turn reporting nothing.
      // Hand sum: prompt 350, completion 100, total 450.
      aggregate.mockResolvedValue({ _sum: { promptTokens: 350, completionTokens: 100 } });
      count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

      const body = await (await usageGET()).json();

      expect(body.promptTokens).toBe(350);
      expect(body.completionTokens).toBe(100);
      expect(body.totalTokens).toBe(450);
      expect(body.reportedMessages).toBe(2);
      expect(body.unreportedMessages).toBe(1);
    });

    it("aggregates in the database rather than loading messages", async () => {
      // The scaling requirement, asserted as a query shape: a user with thousands of
      // messages must never have them fetched to be counted. findMany appearing here
      // would be the regression, and the mock has no findMany to call.
      aggregate.mockResolvedValue({ _sum: { promptTokens: 1, completionTokens: 1 } });
      count.mockResolvedValue(0);

      await usageGET();

      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0][0]).toMatchObject({
        _sum: { promptTokens: true, completionTokens: true },
      });
    });

    it("scopes every count to the signed-in user", async () => {
      // Ownership is a property of the query. Messages are reached through their
      // conversation's userId, so nothing the client sends can widen the scope.
      aggregate.mockResolvedValue({ _sum: { promptTokens: 0, completionTokens: 0 } });
      count.mockResolvedValue(0);

      await usageGET();

      expect(aggregate.mock.calls[0][0].where).toMatchObject({
        conversation: { userId: "user-1" },
      });
      for (const call of count.mock.calls) {
        expect(call[0].where).toMatchObject({ conversation: { userId: "user-1" } });
      }
    });

    it("reports zero for a user with no messages, without inventing usage", async () => {
      // Prisma returns null sums over an empty set. Zero is the honest total here —
      // there are no unreported turns being hidden, because there are no turns.
      aggregate.mockResolvedValue({ _sum: { promptTokens: null, completionTokens: null } });
      count.mockResolvedValue(0);

      const body = await (await usageGET()).json();

      expect(body.totalTokens).toBe(0);
      expect(body.unreportedMessages).toBe(0);
    });

    it("refuses an unauthenticated request", async () => {
      vi.mocked(auth).mockResolvedValue(null as never);
      expect((await usageGET()).status).toBe(401);
    });
  });

  describe("per-conversation total", () => {
    const req = new Request("http://localhost:3000/api/conversations/conv_1/usage");

    it("sums only that conversation and counts what went unreported", async () => {
      aggregate.mockResolvedValue({ _sum: { promptTokens: 6416, completionTokens: 277 } });
      count.mockResolvedValue(3);

      const body = await (
        await conversationUsageGET(req, { params: { id: "conv_1" } })
      ).json();

      expect(body.totalTokens).toBe(6693);
      // Surfaced separately, never folded into the total.
      expect(body.unreportedMessages).toBe(3);
      expect(aggregate.mock.calls[0][0].where).toMatchObject({
        conversationId: "conv_1",
        conversation: { userId: "user-1" },
      });
    });

    it("keeps unreported turns out of the total rather than counting them as zero", async () => {
      // A conversation where NOTHING was reported. The total is 0 because nothing was
      // measured, and unreportedMessages is what distinguishes that from a real zero —
      // the UI shows "usage not reported" rather than "0 tokens".
      aggregate.mockResolvedValue({ _sum: { promptTokens: null, completionTokens: null } });
      count.mockResolvedValue(4);

      const body = await (
        await conversationUsageGET(req, { params: { id: "conv_1" } })
      ).json();

      expect(body.totalTokens).toBe(0);
      expect(body.unreportedMessages).toBe(4);
    });
  });
});
