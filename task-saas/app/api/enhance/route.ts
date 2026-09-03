import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { enhancePrompt, ENHANCER_MAX_INPUT_CHARS } from "@/lib/ai/prompt-enhancer";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Rewrite a composer draft into a clearer request.
 *
 * THIS ROUTE CANNOT SEND ANYTHING. It returns text and nothing else — no message is
 * written, no conversation is touched, no generation is started. The composer shows the
 * result as a suggestion the user accepts or discards, and only the ordinary send path
 * can put anything into a conversation.
 *
 * Rate limited on the same bucket policy as the rest of the API: this is one provider
 * call per click, and a click is cheap to repeat.
 */

const bodySchema = z.object({
  text: z.string().min(1).max(ENHANCER_MAX_INPUT_CHARS),
});

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = checkRateLimit("enhance", userId);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const result = await enhancePrompt(parsed.text);

  /**
   * Every outcome is a 200. A failed enhancement is not an error the user needs to see
   * as one: this is a nice-to-have in front of a draft they already have, and the
   * composer shows their own text unchanged. Surfacing it as a failed request would put
   * a red banner on a feature nobody was blocked by.
   */
  logger.info("Prompt enhancement requested", {
    outcome: result.status,
    userId,
    originalChars: parsed.text.trim().length,
  });

  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
