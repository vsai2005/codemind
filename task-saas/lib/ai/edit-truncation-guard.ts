import { formatStreamPart, parseStreamPart } from "ai";
import {
  editTruncationFor,
  truncationNotice,
  editTruncationAnnotation,
} from "@/lib/ai/repo-edit";
import { logger } from "@/lib/logger";

/**
 * Backstop for a whole-file edit that was cut off mid-stream.
 *
 * WHY A BACKSTOP IS REQUIRED EVEN WITH A PRECONDITION IN FRONT OF IT. The size check in
 * repo-edit.ts refuses files whose estimated output exceeds the budget, but
 * `estimateTokens` is a heuristic — its own comment says it errs optimistic on dense
 * code, which is precisely the direction that lets a file through and then truncates.
 * A precondition that is right most of the time still ships wrong code the rest of it.
 *
 * WHAT IT PREVENTS, measured on the live chat path: an edit to a 1,211-line file
 * returned 966 lines, the fence never closed, and the reply stopped mid-statement
 * inside a catch block. The user was told nothing. `findTruncation` would have caught
 * it instantly, but it lives in the artifact pipeline and the chat path never called it.
 *
 * WHY IT APPENDS RATHER THAN BLOCKS. Truncation is only knowable once the stream ends,
 * and by then the code is already on the user's screen. Holding the whole reply back to
 * find out would trade a visible warning for a blank screen during generation. So the
 * text streams as it always did and a notice is appended at the end — the user sees the
 * code AND that it must not be applied.
 *
 * Follows the same shape as guardChatStream: the wire format is unchanged, so the
 * client parses one continuous stream and needs no special case.
 */
export function guardEditTruncation(
  response: Response,
  context: { conversationId: string; path: string }
): Response {
  const source = response.body;
  if (!source) return response;

  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  /** Accumulated visible text, so the finished reply can be inspected as a whole. */
  let text = "";
  let remainder = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        const signal = editTruncationFor(context.path, text);
        const reason = signal?.reason ?? null;

        if (reason) {
          logger.warn("Edit reply was truncated", {
            conversationId: context.conversationId,
            path: context.path,
            reason,
            replyChars: text.length,
          });
          /**
           * The structured marker goes FIRST, so a consumer that stops reading at the
           * first annotation still sees it, and so it is present even if the text part
           * below is dropped by a client that renders prose selectively.
           */
          controller.enqueue(
            encoder.encode(
              formatStreamPart("message_annotations", [
                editTruncationAnnotation(context.path, reason) as never,
              ])
            )
          );
          controller.enqueue(
            encoder.encode(formatStreamPart("text", truncationNotice(context.path, reason)))
          );
        }

        controller.close();
        return;
      }

      // Forwarded byte-for-byte. This guard only READS the text parts; unlike the
      // output guard it never withholds or rewrites them, so a parsing miss here can
      // cost a warning but can never damage a reply.
      controller.enqueue(value);

      remainder += decoder.decode(value, { stream: true });
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const part = parseStreamPart(line);
          if (part.type === "text") text += part.value as string;
        } catch {
          // A part this version does not understand is not a reason to break the
          // stream. The worst case is a missed warning on a malformed chunk.
        }
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
