import { describe, it, expect } from "vitest";
import { parseArtifactOutput } from "@/lib/artifacts/parse";
import { validateArtifact } from "@/lib/artifacts/validate";

/**
 * Two defects from the GLM 5.3 Flash measurement of 2026-09-03, arm A, 21 cases.
 *
 * Four of the seventeen organic cases were rejected without a single thing being wrong
 * with the project they contained: three over the syntax around a filename, one over a
 * sentence in a README. Both fixtures below are the real shapes, copied from the
 * captured output rather than imagined.
 */

const zipBody = [
  '<file path="package.json">',
  '{ "name": "todo", "dependencies": {} }',
  "</file>",
  '<file path="src/index.ts">',
  "export const run = () => 1;",
  "</file>",
].join("\n");

const envelope = (openTag: string): string =>
  `<codemind_summary>A todo CLI.</codemind_summary>\n${openTag}\n${zipBody}\n</codemind_artifact>`;

describe("a filename written as a bare token", () => {
  /**
   * MEASURED: three of twelve multi-file cases emitted this exact shape and were
   * rejected with "the model did not produce an artifact block", discarding a complete
   * project over the attribute syntax around a filename that was present.
   */
  it("is recovered, reading the name the model actually chose", () => {
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" nodejs-typescript-todo-cli.zip>')
    );

    expect(out.errors).toEqual([]);
    expect(out.artifact?.name).toBe("nodejs-typescript-todo-cli.zip");
    expect(out.artifact?.files).toHaveLength(2);
  });

  it("recovers the other two shapes from the same run", () => {
    for (const name of ["react-vite-counter.zip", "python-web-scraper.zip"]) {
      const out = parseArtifactOutput(envelope(`<codemind_artifact type="zip" ${name}>`));
      expect(out.artifact?.name).toBe(name);
    }
  });

  it("never lets the loose pattern reinterpret a well-formed tag", () => {
    /**
     * MUTATION GUARD. The canonical pattern must win outright. If the tolerant one ever
     * ran first, or ran on a tag that already parsed, a correct filename could be
     * replaced by a fragment of the attribute syntax around it.
     */
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" name="proper-name.zip">')
    );

    expect(out.artifact?.name).toBe("proper-name.zip");
  });

  it("does not invent a name when none was emitted at all", () => {
    /**
     * THE LINE BETWEEN THE TWO MALFORMATIONS, and the reason only one is fixed. Here the
     * model closed the summary with the artifact's closing tag and never opened the
     * block, so no filename exists anywhere in the output. Recovering this would mean
     * INVENTING one, which is a product decision rather than a parsing one.
     */
    const collapsed =
      "<codemind_summary>\nA blog.\n</codemind_artifact>\n" + zipBody + "\n</codemind_artifact>";
    const out = parseArtifactOutput(collapsed);

    expect(out.artifact).toBeNull();
    expect(out.errors[0]).toContain("did not produce an artifact block");
  });

  it("does not match a token that is not filename-shaped", () => {
    // The dot is what keeps this anchored to something that looks like a filename
    // rather than any stray word the model might leave in the tag.
    const out = parseArtifactOutput(envelope('<codemind_artifact type="zip" archive>'));

    expect(out.artifact).toBeNull();
  });
});

describe("counting Markdown fences", () => {
  const zipWith = (readme: string) =>
    validateArtifact(
      {
        type: "zip",
        name: "docs.zip",
        files: [
          { path: "package.json", content: '{ "name": "d", "dependencies": {} }' },
          { path: "README.md", content: readme },
        ],
        body: "",
      } as never,
      "zip"
    );

  it("ignores backticks inside a sentence", () => {
    /**
     * THE FALSE REJECTION. This README is the real one from zip-markdown-tool: three
     * properly paired fences plus one line of prose mentioning them. Seven occurrences,
     * an odd number, and the whole project was rejected as malformed.
     */
    const readme = [
      "# Markdown Tool",
      "",
      "- Fenced code blocks (```) with language labels",
      "",
      "```bash",
      "npm install",
      "```",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "```bash",
      "npm start",
      "```",
    ].join("\n");

    expect(zipWith(readme).ok).toBe(true);
  });

  it("still catches a genuinely unclosed fence", () => {
    /**
     * THE GUARD THAT MATTERS MOST. A false PASS here is worse than the false rejection
     * just fixed: a truncated file would ship looking complete. One opener, no closer.
     */
    const readme = ["# Docs", "", "```bash", "npm install"].join("\n");
    const result = zipWith(readme);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("unclosed code fence");
  });

  it("counts an indented fence but not a four-space one", () => {
    // Up to three spaces is still a fence in CommonMark; four makes it an indented code
    // block, where the backticks are literal text.
    const threeSpaces = ["# D", "", "   ```", "x", "   ```"].join("\n");
    expect(zipWith(threeSpaces).ok).toBe(true);

    const fourSpacesOnly = ["# D", "", "    ```", "just literal text"].join("\n");
    expect(zipWith(fourSpacesOnly).ok).toBe(true);
  });

  it("is not fooled by a fence closing an odd count from prose", () => {
    // Two prose mentions and one real unclosed fence: substring counting would see an
    // even number and pass it.
    const readme = [
      "# D",
      "Use ``` to open and ``` to close.",
      "",
      "```bash",
      "npm i",
    ].join("\n");

    expect(zipWith(readme).ok).toBe(false);
  });
});
