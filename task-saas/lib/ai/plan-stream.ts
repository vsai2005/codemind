import { formatStreamPart, type JSONValue } from "ai";

/**
 * Emit extra data-stream parts ahead of a model stream.
 *
 * `streamText().toDataStreamResponse()` produces a complete AI SDK data stream, so the
 * plan cannot simply be appended to it. Instead the plan is written as a leading
 * message annotation and the model's stream is concatenated after it — the wire format
 * is identical, so the client parses one continuous stream and needs no special case.
 *
 * Annotations must arrive with (or before) the text they belong to, which is why this
 * prefixes rather than appends.
 */
export function createDataStreamPrefix(
  response: Response,
  annotations: JSONValue[]
): Response {
  if (annotations.length === 0) return response;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(formatStreamPart("message_annotations", annotations));

  const source = response.body;
  if (!source) return response;

  const reader = source.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      // Propagate cancellation so Stop actually tears down the upstream request.
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
