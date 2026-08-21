import { formatStreamPart, type JSONValue } from "ai";
import type { ArtifactPhase } from "./types";

/**
 * A hand-rolled AI SDK data stream for the artifact pipeline.
 *
 * Artifact responses are not a model text stream, so `streamText().toDataStreamResponse()`
 * does not apply. This emits the same wire protocol by hand:
 *
 *   `2:` data parts        → transient progress the UI shows while working
 *   `0:` text parts        → the concise, user-visible message
 *   `8:` message annotations → artifact metadata attached to the assistant message
 *   `d:` finish
 *
 * Ordering matters: the client only attaches annotations to a message that already has
 * text, so `text()` must be called before `annotate()`.
 */

export interface ArtifactStreamWriter {
  /** Transient progress. Never persisted, never part of message content. */
  progress(phase: ArtifactPhase, label: string): void;
  /** User-visible assistant text. */
  text(value: string): void;
  /** Structured metadata attached to the assistant message. */
  annotate(value: JSONValue): void;
}

export function createArtifactStreamResponse(
  run: (writer: ArtifactStreamWriter) => Promise<void>,
  init?: { headers?: Record<string, string> }
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (part: string): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(part));
      };

      const writer: ArtifactStreamWriter = {
        progress(phase, label) {
          send(formatStreamPart("data", [{ codemindProgress: { phase, label } }]));
        },
        text(value) {
          if (value.length > 0) send(formatStreamPart("text", value));
        },
        annotate(value) {
          send(formatStreamPart("message_annotations", [value]));
        },
      };

      try {
        await run(writer);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Artifact generation failed.";
        // Surface as readable text rather than a stream error so the user sees why.
        send(formatStreamPart("text", `\n\n${message}`));
      } finally {
        send(formatStreamPart("finish_message", { finishReason: "stop" }));
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Vercel-AI-Data-Stream": "v1",
      ...init?.headers,
    },
  });
}
