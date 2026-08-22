import { formatStreamPart, parseStreamPart } from "ai";
import { logger } from "@/lib/logger";

/**
 * Deterministic guard over the chat model's visible output.
 *
 * WHY THIS EXISTS
 *
 * Asked for a PDF on the plain chat path, the model invented a tool it does not have
 * and streamed this into the reply:
 *
 *   { "tool": "write_code", "arguments": { "language": "python", "code": "..." } }
 *
 * Nothing was listening for it. It produced no file, consumed the entire output budget
 * on escaped JSON, and truncated mid-string — so the user got neither an answer nor a
 * download. The system prompt was then told, over three revisions, not to do this.
 *
 * A prompt cannot guarantee it. This can: the pattern is structural, it is never
 * legitimate in a chat reply, and the application can simply refuse to forward it.
 * Prompts guide behaviour; application logic enforces it.
 *
 * SCOPE — deliberately narrow
 *
 * This blocks ONE thing: bare tool-call syntax outside a code fence. It does not
 * rewrite prose. The model's other capability slips (refusing a download CodeMind can
 * produce, or promising one that is not coming) are prose, and pattern-matching prose
 * risks mangling legitimate text — a reply that discusses building a download feature
 * would be a false positive. Those stay prompt-guided; the counters below exist so the
 * decision to go further can be made from evidence rather than anecdote.
 *
 * THE FENCE RULE
 *
 * Inside a fenced code block, everything passes through untouched. A model explaining
 * an MCP config or a function-calling API legitimately writes {"tool": ...} in a
 * fence, and blocking that would be worse than the bug. The hallucinated call arrived
 * as bare prose — that is the discriminator.
 */

/**
 * Keys that identify a tool-call object. `arguments` is included because some models
 * emit {"name": ..., "arguments": ...} without a `tool` key at all.
 */
const TOOL_CALL_KEYS = ["tool", "name", "function", "recipient", "arguments", "tool_name"];

/** A confirmed tool call: an object literal opening on one of those keys. */
const TOOL_CALL_TRIGGER = new RegExp(`\\{\\s*"(?:${TOOL_CALL_KEYS.join("|")})"\\s*:`);

/**
 * The complete strings a trigger can settle into, whitespace removed. A tail is held
 * only while it is still a prefix of one of these.
 *
 * Comparing against the KEY alone was the first version and was wrong: at `{ "tool"`
 * the remaining candidate is `tool"`, which is not a prefix of any key, so the text was
 * released one character before the `:` that confirms it. Comparing against the whole
 * target keeps it held exactly until the question is settled.
 */
const TRIGGER_TARGETS = TOOL_CALL_KEYS.map((key) => `{"${key}":`);

/**
 * Cap on held text, so a stray `{` cannot stall the stream. `{"tool_name":` is the
 * longest target, so this is generous.
 */
const MAX_HOLD_CHARS = 32;

/** Shown in place of the suppressed output, so the turn is not silently empty. */
export const TOOL_CALL_BLOCKED_NOTICE =
  "\n\n_CodeMind stopped this reply: the model started calling a tool that does not exist, " +
  "which would have produced nothing. For a real file, ask for it directly — " +
  'for example "give me this as a PDF"._';

/** Whitespace carries no meaning inside the trigger, and models vary in spacing. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * The index from which text must be held back because it could still grow into a
 * trigger, or -1 when all of it is safe to emit.
 *
 * Two things can be incomplete at a chunk boundary: an opening object literal, and a
 * fence marker (``` split as ` + ``). Both are checked, so neither is misread.
 */
function fenceTailHold(text: string): number {
  // A ``` split across chunks must be rejoined, or the fence state is misjudged and
  // the block never closes - which silently disables the guard for the rest of the
  // reply. Holding the trailing backticks costs at most two characters of latency.
  const fenceTail = text.match(/`{1,2}$/);
  return fenceTail ? text.length - fenceTail[0].length : -1;
}

function holdFrom(text: string): number {
  const fenceHold = fenceTailHold(text);

  let braceHold = -1;
  const open = text.lastIndexOf("{");
  if (open !== -1) {
    const tail = text.slice(open);
    if (tail.length <= MAX_HOLD_CHARS) {
      const candidate = squeeze(tail).toLowerCase();
      if (TRIGGER_TARGETS.some((target) => target.startsWith(candidate))) {
        braceHold = open;
      }
    }
  }

  if (fenceHold === -1) return braceHold;
  if (braceHold === -1) return fenceHold;
  return Math.min(fenceHold, braceHold);
}

export interface GuardResult {
  /** Text safe to forward now. May be empty while a candidate is being resolved. */
  emit: string;
  /** True on the chunk where a tool call was confirmed. */
  blockedNow: boolean;
}

/**
 * Streaming state machine over the model's visible text.
 *
 * Separated from the stream plumbing so it can be tested against arbitrary chunk
 * boundaries — the failure only appears when a pattern is split across chunks, which
 * is exactly what a token stream does.
 */
export class ChatOutputGuard {
  private pending = "";
  private blocked = false;
  /**
   * Whether the text committed so far ends inside a fenced block. Tracked
   * incrementally rather than recomputed over the whole buffer: what matters is
   * whether the TRIGGER'S POSITION is fenced, not whether the buffer happens to end
   * inside a fence. Recomputing over the buffer blocked legitimate fenced JSON
   * whenever the closing fence arrived in the same chunk.
   */
  private fenceOpen = false;

  /** True once a tool call was confirmed; all later text is discarded. */
  get isBlocked(): boolean {
    return this.blocked;
  }

  push(chunk: string): GuardResult {
    if (this.blocked) return { emit: "", blockedNow: false };

    this.pending += chunk;

    // Walk forward, toggling fence state, and stop at a trigger that is NOT fenced.
    let cursor = 0;
    while (cursor < this.pending.length) {
      const nextFence = this.pending.indexOf("```", cursor);

      if (this.fenceOpen) {
        // Everything up to the closing fence is verbatim.
        if (nextFence === -1) break;
        this.fenceOpen = false;
        cursor = nextFence + 3;
        continue;
      }

      const match = TOOL_CALL_TRIGGER.exec(this.pending.slice(cursor));
      const triggerAt = match ? cursor + match.index : -1;

      // A trigger only counts when it comes before the next fence opens.
      if (triggerAt !== -1 && (nextFence === -1 || triggerAt < nextFence)) {
        this.blocked = true;
        const prefix = this.pending.slice(0, triggerAt).trimEnd();
        this.pending = "";
        return { emit: prefix + TOOL_CALL_BLOCKED_NOTICE, blockedNow: true };
      }

      if (nextFence === -1) break;
      this.fenceOpen = true;
      cursor = nextFence + 3;
    }

    // No trigger. Hold only what could still become one. Inside a fence the trigger
    // check is off, but a partial closing marker must still be held.
    const hold = this.fenceOpen ? fenceTailHold(this.pending) : holdFrom(this.pending);
    if (hold === -1) {
      const out = this.pending;
      this.pending = "";
      return { emit: out, blockedNow: false };
    }

    const safe = this.pending.slice(0, hold);
    this.pending = this.pending.slice(hold);
    return { emit: safe, blockedNow: false };
  }

  /** Release anything still held. Called when the model stream ends. */
  flush(): string {
    if (this.blocked) return "";
    const out = this.pending;
    this.pending = "";
    return out;
  }
}

/**
 * Wrap a data-stream Response so its text parts pass through the guard.
 *
 * Follows the same shape as createDataStreamPrefix: the wire format is unchanged, so
 * the client parses one continuous stream and needs no special case. Non-text parts —
 * annotations, finish reasons, errors — are forwarded byte-for-byte.
 */
export function guardChatStream(response: Response, context: { conversationId: string }): Response {
  const source = response.body;
  if (!source) return response;

  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const guard = new ChatOutputGuard();

  let remainder = "";

  const stream = new ReadableStream<Uint8Array>({
    /**
     * Each call MUST enqueue at least one chunk or close the stream.
     *
     * A pull that returns having enqueued nothing is never called again, and the
     * response hangs forever. That is not hypothetical: this guard emits nothing
     * whenever a chunk is entirely held back (a chunk that is just `{`) and on every
     * chunk after a block, so the first version deadlocked real replies. Hence the
     * loop — keep draining the source until there is something to hand on.
     */
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            const tail = guard.flush();
            if (tail.length > 0) {
              controller.enqueue(encoder.encode(formatStreamPart("text", tail)));
            }
            controller.close();
            return;
          }

          remainder += decoder.decode(value, { stream: true });
          const lines = remainder.split("\n");
          // The final element is an incomplete line; keep it for the next read.
          remainder = lines.pop() ?? "";

          let enqueued = false;

          for (const line of lines) {
            if (line.trim().length === 0) continue;

            let part: { type: string; value: unknown };
            try {
              part = parseStreamPart(line) as { type: string; value: unknown };
            } catch {
              // Not a frame we understand. Forward it rather than dropping data.
              controller.enqueue(encoder.encode(`${line}\n`));
              enqueued = true;
              continue;
            }

            if (part.type !== "text" || typeof part.value !== "string") {
              controller.enqueue(encoder.encode(`${line}\n`));
              enqueued = true;
              continue;
            }

            const { emit, blockedNow } = guard.push(part.value);

            if (blockedNow) {
              logger.warn("Blocked hallucinated tool call in chat output", {
                conversationId: context.conversationId,
              });
            }

            if (emit.length > 0) {
              controller.enqueue(encoder.encode(formatStreamPart("text", emit)));
              enqueued = true;
            }
          }

          if (enqueued) return;
          // Nothing to emit yet — read more rather than stalling the consumer.
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
