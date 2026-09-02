import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { findTruncation } from "@/lib/artifacts/validate";
import { parseArtifactOutput } from "@/lib/artifacts/parse";

/**
 * Bracket balance in files containing regex literals.
 *
 * THE DEFECT THIS PINS DOWN, measured on a 42-case run in BOTH arms.
 * The local stripper handled comments and strings but had no notion of a regex literal,
 * so in
 *
 *     .replace(/"/g, '&quot;')
 *
 * the quote INSIDE the regex opened a string that never closed. Everything after it —
 * including the file's final brace — was swallowed, and a complete, balanced file was
 * reported as having one unclosed brace. HTML escaping is common enough that this was
 * rejecting ordinary work: two markdown-tool projects, identical error, both arms.
 *
 * mask-code.ts already handled regex literals and explains why in its own comment. The
 * bug existed because there were TWO implementations and only one was right; the fix is
 * that there is now one. These tests pin the behaviour at the boundary that matters, so
 * a future re-divergence fails here rather than in a measurement run.
 *
 * EVERY FIXTURE CONTAINS A QUOTE OR COMMENT MARKER INSIDE A REGEX. A fixture with a
 * plain regex like /\d+/ passes before and after and proves nothing.
 */

/** A complete, balanced function. Only the regex contents vary. */
const escaper = (body: string): string =>
  ["function escapeHtml(s) {", "  return s", `    ${body};`, "}"].join("\n");

describe("a regex containing a quote", () => {
  it("accepts a double quote inside a regex, the exact rejected construct", () => {
    expect(findTruncation("a.js", escaper(`.replace(/"/g, '&quot;')`))).toBeNull();
  });

  it("accepts a single quote inside a regex", () => {
    expect(findTruncation("a.js", escaper(`.replace(/'/g, "&#39;")`))).toBeNull();
  });

  it("accepts a backtick inside a regex", () => {
    expect(findTruncation("a.js", escaper(".replace(/`/g, '&#96;')"))).toBeNull();
  });

  it("accepts the full escaping chain, as generated", () => {
    // Reconstructed from the rejected file: five chained replaces, three of which put
    // a quote character inside a regex.
    const source = [
      "function escapeHtml(text) {",
      "  return text",
      "    .replace(/&/g, '&amp;')",
      "    .replace(/</g, '&lt;')",
      "    .replace(/>/g, '&gt;')",
      `    .replace(/"/g, '&quot;')`,
      `    .replace(/'/g, '&#39;');`,
      "}",
    ].join("\n");

    expect(findTruncation("src/render.js", source)).toBeNull();
  });
});

describe("a regex containing comment markers", () => {
  it("accepts a regex containing //", () => {
    // Without regex handling this starts a line comment and eats the closing brace.
    expect(findTruncation("a.js", escaper(".replace(/https:\\/\\//g, '')"))).toBeNull();
  });

  it("accepts a regex containing /*", () => {
    expect(findTruncation("a.js", escaper(".split(/[/*]/)"))).toBeNull();
  });

  it("accepts a character class containing a slash", () => {
    // The `]`-aware scan matters here: a naive one closes the regex at the inner slash.
    expect(findTruncation("a.js", escaper(".split(/[a-z/]+/)"))).toBeNull();
  });

  it("accepts a character class holding BOTH a slash and a quote", () => {
    // Sharpened after mutation testing. The fixture above only makes a naive scan close
    // the regex EARLY, which leaves a stray `]` — an extra CLOSER, and the check reports
    // only excess openers, so that mutant survived. Here the early close leaves `"]/)`
    // behind: the quote opens a string that runs to end of file and swallows the closing
    // brace, which the check does report. Same construct, now with teeth.
    expect(findTruncation("a.js", escaper('.split(/[/"]/)'))).toBeNull();
  });
});

describe("genuinely truncated files are still caught", () => {
  it("still catches a real unclosed brace alongside a quoted regex", () => {
    // THE PAIRING THAT KEEPS THIS HONEST. Same regex construct, genuinely missing a
    // closing brace — a fix that simply stopped counting would pass the tests above
    // and fail this one.
    const source = [
      "function escapeHtml(s) {",
      "  if (s) {",
      `    return s.replace(/"/g, '&quot;');`,
      "}",
    ].join("\n");

    expect(findTruncation("a.js", source)).toMatch(/unclosed brace/);
  });

  it("still catches an unclosed bracket", () => {
    expect(findTruncation("a.js", "const a = [1, 2,\nconst b = 3;")).toMatch(/unclosed bracket/);
  });

  it("still catches an unclosed parenthesis", () => {
    expect(findTruncation("a.js", "foo(bar(1,\nconst b = 2;")).toMatch(/unclosed parenthesis/);
  });

  it("still catches a file that ends mid-statement", () => {
    expect(findTruncation("a.js", "const ratio = total /")).toMatch(/mid-statement/);
  });

  it("still catches an empty file", () => {
    expect(findTruncation("a.js", "  \n ")).toMatch(/is empty/);
  });

  it("does not count braces inside strings or comments", () => {
    // The behaviour the original stripper existed for, preserved by the replacement.
    const source = ['const s = "{{{";', "// }}}", "/* { */", "export default s;"].join("\n");

    expect(findTruncation("a.js", source)).toBeNull();
  });
});

describe("the captured generations", () => {
  /**
   * The real rejected bytes, kept by the raw-output capture. Guarded on existence
   * because `.measure/` is local evidence and gitignored.
   */
  const renderJs = (stem: string): string | null => {
    const p = `.measure/run42/${stem}.raw.txt`;
    if (!existsSync(p)) return null;
    const parsed = parseArtifactOutput(readFileSync(p, "utf8"));
    return parsed.artifact?.files.find((f) => /render\.js$/.test(f.path))?.content ?? null;
  };

  for (const stem of ["A__zip-markdown-tool", "B__zip-markdown-tool"]) {
    it(`accepts the file rejected in ${stem}`, () => {
      const content = renderJs(stem);
      if (content === null) return;

      // Sanity: the file really is balanced in raw text, so any imbalance was invented.
      const opens = (content.match(/\{/g) ?? []).length;
      const closes = (content.match(/\}/g) ?? []).length;
      expect(opens).toBe(closes);

      expect(findTruncation("src/render.js", content)).toBeNull();
    });
  }
});
