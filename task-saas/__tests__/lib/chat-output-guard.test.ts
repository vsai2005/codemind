import { describe, it, expect } from "vitest";
import { formatStreamPart } from "ai";
import {
  ChatOutputGuard,
  TOOL_CALL_BLOCKED_NOTICE,
  guardChatStream,
} from "@/lib/ai/chat-output-guard";

/**
 * Feed text through the guard one chunk at a time and collect what a client would see.
 * `size` mimics a token stream: the bug only appears when a pattern is split across
 * chunk boundaries, so the same input is exercised at several splits.
 */
function run(text: string, size: number): { output: string; blocked: boolean } {
  const guard = new ChatOutputGuard();
  let output = "";
  let blocked = false;

  for (let i = 0; i < text.length; i += size) {
    const result = guard.push(text.slice(i, i + size));
    output += result.emit;
    if (result.blockedNow) blocked = true;
  }
  output += guard.flush();

  return { output, blocked };
}

/** Chunk sizes chosen to split the trigger at every interesting position. */
const SPLITS = [1, 2, 3, 5, 7, 13, 64, 4096];

/** The real payload, from the production failure. */
const HALLUCINATED =
  'I\'ll create a basic HTML calendar and deliver it as a PDF containing the source ' +
  '{ "tool": "write_code", "arguments": { "language": "python", "code": "from fpdf import FPDF" } }';

describe("ChatOutputGuard", () => {
  describe("blocks hallucinated tool calls", () => {
    for (const size of SPLITS) {
      it(`blocks the real payload at chunk size ${size}`, () => {
        const { output, blocked } = run(HALLUCINATED, size);

        expect(blocked).toBe(true);
        // The JSON never reaches the client, at any split.
        expect(output).not.toContain('"tool"');
        expect(output).not.toContain("write_code");
        expect(output).not.toContain("fpdf");
        // The prose that preceded it is kept - it was a real answer opening.
        expect(output).toContain("I'll create a basic HTML calendar");
        // And the user is told what happened rather than seeing a truncated reply.
        expect(output).toContain(TOOL_CALL_BLOCKED_NOTICE.trim().slice(0, 40));
      });
    }

    for (const variant of [
      '{"tool": "x"}',
      '{ "tool" : "x" }',
      '{"name": "write_code", "arguments": {}}',
      '{"function": "run"}',
      '{"arguments": {"a": 1}}',
      '{"tool_name": "run"}',
    ]) {
      it(`blocks the shape ${variant}`, () => {
        expect(run(`here you go ${variant}`, 3).blocked).toBe(true);
      });
    }

    it("discards everything after the block, including a second call", () => {
      const { output } = run(`prose ${'{"tool": "a"}'} more text {"tool": "b"}`, 5);
      expect(output).not.toContain('"tool"');
      expect(output).not.toContain("more text");
    });
  });

  describe("does not touch legitimate output", () => {
    for (const size of SPLITS) {
      it(`passes ordinary prose through unchanged at chunk size ${size}`, () => {
        const text = "Here is how HTTP caching works. The Cache-Control header decides freshness.";
        const { output, blocked } = run(text, size);
        expect(blocked).toBe(false);
        expect(output).toBe(text);
      });
    }

    for (const size of SPLITS) {
      it(`passes ordinary code through unchanged at chunk size ${size}`, () => {
        const text = 'function f() {\n  const o = { a: 1, b: "two" };\n  return o;\n}';
        const { output, blocked } = run(text, size);
        expect(blocked).toBe(false);
        expect(output).toBe(text);
      });
    }

    /**
     * The false positive that would be worse than the bug: a reply legitimately
     * explaining tool-call JSON. Inside a fence it must survive untouched.
     */
    for (const size of SPLITS) {
      it(`allows tool-call JSON inside a code fence at chunk size ${size}`, () => {
        const text =
          'An MCP tool call looks like this:\n\n```json\n{ "tool": "search", "arguments": { "q": "x" } }\n```\n\nThat is the shape.';
        const { output, blocked } = run(text, size);
        expect(blocked).toBe(false);
        expect(output).toBe(text);
      });
    }

    it("resumes guarding after a fence closes", () => {
      const text = '```json\n{"tool": "ok"}\n```\nand now bare {"tool": "bad"}';
      const { output, blocked } = run(text, 4);
      expect(blocked).toBe(true);
      // The fenced example survived; the bare call did not.
      expect(output).toContain('{"tool": "ok"}');
      expect(output).not.toContain("bad");
    });

    it("releases a held candidate that turns out benign", () => {
      // "{ \"tools\" :" is close to the trigger but is not one - "tools" is not a key.
      const text = 'the config is { "tools_enabled": true } and that is all';
      const { output, blocked } = run(text, 3);
      expect(blocked).toBe(false);
      expect(output).toBe(text);
    });

    it("does not stall on a stray opening brace", () => {
      const text = "use { to open a block";
      const { output, blocked } = run(text, 2);
      expect(blocked).toBe(false);
      expect(output).toBe(text);
    });
  });

  describe("stream mechanics", () => {
    it("emits nothing after being blocked", () => {
      const guard = new ChatOutputGuard();
      guard.push('x {"tool": "a"}');
      expect(guard.isBlocked).toBe(true);
      expect(guard.push("more").emit).toBe("");
      expect(guard.flush()).toBe("");
    });

    it("reports blockedNow exactly once", () => {
      const guard = new ChatOutputGuard();
      const first = guard.push('{"tool": "a"}');
      const second = guard.push(" trailing");
      expect(first.blockedNow).toBe(true);
      expect(second.blockedNow).toBe(false);
    });

    it("loses no characters for benign input, at any split", () => {
      const text = "The quick brown fox { jumps } over the lazy dog, 12345.";
      for (const size of SPLITS) {
        expect(run(text, size).output, `chunk size ${size}`).toBe(text);
      }
    });
  });

  describe("guardChatStream over the real wire format", () => {
    /** Build a data-stream Response the way toDataStreamResponse would. */
    function streamOf(parts: string[]): Response {
      const encoder = new TextEncoder();
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= parts.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(parts[i++]));
        },
      });
      return new Response(body, { headers: { "x-conversation-id": "conv_1" } });
    }

    async function collect(response: Response): Promise<string> {
      const text = await response.text();
      return text;
    }

    it("strips a tool call while preserving the surrounding protocol", async () => {
      const guarded = guardChatStream(
        streamOf([
          formatStreamPart("text", "Here you go "),
          formatStreamPart("text", '{"tool": "write_code"'),
          formatStreamPart("text", ', "arguments": {}}'),
          formatStreamPart("finish_message", { finishReason: "stop" } as never),
        ]),
        { conversationId: "conv_1" }
      );

      const wire = await collect(guarded);
      expect(wire).not.toContain("write_code");
      expect(wire).toContain("Here you go");
      // Non-text frames must survive untouched.
      expect(wire).toContain("finishReason");
    });

    it("passes a clean reply through byte-for-byte in content", async () => {
      const guarded = guardChatStream(
        streamOf([
          formatStreamPart("text", "Caching works "),
          formatStreamPart("text", "like this."),
        ]),
        { conversationId: "conv_1" }
      );

      const wire = await collect(guarded);
      expect(wire).toContain("Caching works");
      expect(wire).toContain("like this.");
    });

    it("preserves response headers", async () => {
      const guarded = guardChatStream(streamOf([formatStreamPart("text", "hi")]), {
        conversationId: "conv_1",
      });
      expect(guarded.headers.get("x-conversation-id")).toBe("conv_1");
    });

    /**
     * The deadlock. A pull that enqueues nothing is never called again, so the
     * response hangs. The guard emits nothing on every chunk after a block, and
     * whenever a chunk is held back whole - a chunk that is just "{" - so the first
     * version stalled real replies, not just this test.
     */
    it("terminates when several chunks in a row emit nothing", async () => {
      const guarded = guardChatStream(
        streamOf([
          formatStreamPart("text", "before "),
          formatStreamPart("text", '{"tool": "x"}'),
          formatStreamPart("text", " dropped 1"),
          formatStreamPart("text", " dropped 2"),
          formatStreamPart("text", " dropped 3"),
          formatStreamPart("finish_message", { finishReason: "stop" } as never),
        ]),
        { conversationId: "conv_1" }
      );

      const wire = await collect(guarded);
      expect(wire).toContain("before");
      expect(wire).not.toContain("dropped");
      expect(wire).toContain("finishReason");
    });

    it("terminates when a chunk is held back whole", async () => {
      // "{" alone is held pending - it could still become a trigger - so this pull
      // emits nothing even though nothing is wrong.
      const guarded = guardChatStream(
        streamOf([
          formatStreamPart("text", "value "),
          formatStreamPart("text", "{"),
          formatStreamPart("text", ' "count": 1 }'),
        ]),
        { conversationId: "conv_1" }
      );

      const wire = await collect(guarded);
      expect(wire).toContain("value");
      expect(wire).toContain("count");
    });

    it("forwards frames it cannot parse rather than dropping data", async () => {
      const guarded = guardChatStream(streamOf(["not-a-valid-frame\n"]), {
        conversationId: "conv_1",
      });
      expect(await collect(guarded)).toContain("not-a-valid-frame");
    });
  });
});
