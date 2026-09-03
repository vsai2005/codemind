import { describe, it, expect } from "vitest";
import { describeChatError, isConversationGone } from "@/components/chat/ChatError";

/**
 * Telling "this turn failed" apart from "this conversation is gone".
 *
 * EVERY OTHER FAILURE IS WORTH RESENDING. A rate limit passes, a provider recovers, a
 * timeout may not repeat — Retry is the right and only action. A conversation that no
 * longer exists returns the same 404 forever, so a banner offering only Retry hands the
 * user a button guaranteed not to work and no way off that screen.
 *
 * This became reachable when a local Postgres volume was recreated: the rows were gone
 * while open tabs still held their ids, and every send answered
 * `{"error":"Conversation not found or unauthorized"}` with a 404.
 *
 * Matched on the message, not a status code, because the AI SDK hands this layer the
 * response BODY. Fixtures below are the literal bodies the route returns.
 */

const asError = (body: string): Error => new Error(body);

describe("recognising a conversation that no longer exists", () => {
  it("matches the route's own 404 body", () => {
    expect(
      isConversationGone(asError('{"error":"Conversation not found or unauthorized"}'))
    ).toBe(true);
  });

  it("does not match failures that are worth retrying", () => {
    /**
     * THE DISTINCTION THAT MATTERS. Each of these is transient, and turning Retry into
     * "Start a new chat" for them would throw away a conversation over a hiccup —
     * strictly worse than the bug being fixed.
     */
    const retryable = [
      '{"error":"An error occurred during chat processing"}',
      '{"error":"You already have 3 responses in progress. Wait for one to finish."}',
      '{"error":"Too many requests. Wait a moment and try again."}',
      '{"error":"That model is not available. Pick a different one and try again."}',
      '{"error":"Project not found"}',
    ];

    for (const body of retryable) {
      expect(isConversationGone(asError(body))).toBe(false);
    }
  });

  it("is not fooled by a network drop or an HTML error page", () => {
    // describeChatError reduces both to a generic sentence, which must not match.
    expect(isConversationGone(asError("<html><body>502 Bad Gateway</body></html>"))).toBe(false);
    expect(isConversationGone(asError(""))).toBe(false);
    expect(isConversationGone(asError("Failed to fetch"))).toBe(false);
  });

  it("reads the parsed message, not the raw body", () => {
    /**
     * MUTATION GUARD for WHERE the match happens. A proxy page that happens to contain
     * the phrase is not this route saying the conversation is gone, and describeChatError
     * already reduces any markup body to a generic sentence. Testing the raw string
     * instead would let this through and offer to abandon a conversation that exists.
     */
    expect(isConversationGone(asError("<html><body>Conversation not found</body></html>"))).toBe(
      false
    );
  });

  it("reads the message out of the JSON body, not the raw string", () => {
    // The banner shows this text, so the two must agree on what the error says.
    expect(describeChatError(asError('{"error":"Conversation not found or unauthorized"}'))).toBe(
      "Conversation not found or unauthorized"
    );
  });
});
