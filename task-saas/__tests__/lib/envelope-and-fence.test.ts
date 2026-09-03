import { describe, it, expect } from "vitest";
import { parseArtifactOutput, RECOVERED_ARCHIVE_NAME } from "@/lib/artifacts/parse";
import { validateArtifact } from "@/lib/artifacts/validate";

/**
 * Envelope malformations from the GLM 5.3 Flash measurement of 2026-09-03, and the fence
 * counter that rejected a valid README.
 *
 * Seven of seventeen organic cases failed; four had nothing wrong with the project they
 * carried. Every fixture below is a real shape copied from captured output.
 *
 * THE ORDERING PRINCIPLE for the recoveries: read what the model actually wrote wherever
 * it wrote it, and invent only when there is provably nothing to read.
 */

const FENCE = "```";

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
   * MEASURED: three of twelve multi-file cases emitted this and were rejected with "the
   * model did not produce an artifact block", discarding a complete project over the
   * attribute syntax around a filename that was present.
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

  it("never lets a looser pattern reinterpret a well-formed tag", () => {
    /**
     * MUTATION GUARD. The canonical pattern must win outright, or a correct filename
     * could be replaced by a fragment of the syntax around it.
     */
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" name="proper-name.zip">')
    );

    expect(out.artifact?.name).toBe("proper-name.zip");
  });

  it("does not adopt a token that is not filename-shaped", () => {
    /**
     * The dot is what keeps the bare-token pattern anchored to something filename-like.
     * "archive" is not a filename, so it is NOT adopted as one — the archive falls
     * through to the generic recovery below rather than being named after a stray word.
     */
    const out = parseArtifactOutput(envelope('<codemind_artifact type="zip" archive>'));

    expect(out.artifact?.name).not.toBe("archive");
    expect(out.artifact?.name).toBe(RECOVERED_ARCHIVE_NAME);
  });
});

describe("a filename emitted twice", () => {
  /**
   * OBSERVED LIVE while re-probing the first round of fixes. The real attribute is
   * present and correct; only the rubbish before it needs stepping over.
   */
  it("steps over the stray token and reads the real attribute", () => {
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" markdown-to-html.zip" name="markdown-to-html.zip">')
    );

    expect(out.errors).toEqual([]);
    expect(out.artifact?.name).toBe("markdown-to-html.zip");
  });

  it("cannot borrow a name from a later element", () => {
    // MUTATION GUARD. The pattern uses [^>]*, which cannot cross a ">", so the search
    // stays inside the one tag rather than reaching into the next element for a name.
    const out = parseArtifactOutput(
      '<codemind_summary>x</codemind_summary>\n<codemind_artifact type="zip">\n' +
        '<file path="a.ts" name="not-the-archive.zip">\nx\n</file>\n</codemind_artifact>'
    );

    expect(out.artifact?.name).not.toBe("not-the-archive.zip");
  });
});

describe("an opening tag that never appeared", () => {
  /**
   * THE ONLY PLACE THIS PARSER INVENTS ANYTHING. The model closed the summary with
   * </codemind_artifact> and never opened the block, so the filename does not exist
   * anywhere in the output — there is nothing to read.
   *
   * Two of seventeen organic cases were discarded this way, each carrying a complete
   * project. A generic name the user can change beats no file at all, and the summary
   * still tells them what it is.
   */
  const collapsed = (body: string) =>
    "<codemind_summary>\nA blog.\n</codemind_artifact>\n" + body + "\n</codemind_artifact>";

  it("recovers the project under a generic name", () => {
    const out = parseArtifactOutput(collapsed(zipBody));

    expect(out.errors).toEqual([]);
    expect(out.artifact?.name).toBe("project.zip");
    expect(out.artifact?.type).toBe("zip");
    expect(out.artifact?.files).toHaveLength(2);
  });

  it("keeps the summary, which is what tells the user what they got", () => {
    expect(parseArtifactOutput(collapsed(zipBody)).summary).toBe("A blog.");
  });

  it("ships a placeholder-looking name rather than a confident guess", () => {
    // Derived from the summary prose it would sometimes be plausibly wrong, which reads
    // worse than something obviously generic.
    expect(RECOVERED_ARCHIVE_NAME).toBe("project.zip");
  });

  it("refuses when there are no file blocks to recover", () => {
    /**
     * MUTATION GUARD, and the boundary of the whole recovery. File blocks are the only
     * evidence a project is present; without them, producing an archive would be
     * fabrication rather than recovery.
     */
    const out = parseArtifactOutput(
      "<codemind_summary>\nA doc.\n</codemind_artifact>\njust prose\n</codemind_artifact>"
    );

    expect(out.artifact).toBeNull();
    expect(out.errors[0]).toContain("did not produce an artifact block");
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
      `- Fenced code blocks (${FENCE}) with language labels`,
      "",
      `${FENCE}bash`,
      "npm install",
      FENCE,
      "",
      `${FENCE}bash`,
      "npm test",
      FENCE,
      "",
      `${FENCE}bash`,
      "npm start",
      FENCE,
    ].join("\n");

    expect(zipWith(readme).ok).toBe(true);
  });

  it("still catches a genuinely unclosed fence", () => {
    /**
     * THE GUARD THAT MATTERS MOST. A false PASS here is worse than the false rejection
     * just fixed: a truncated file would ship looking complete.
     */
    const result = zipWith(["# Docs", "", `${FENCE}bash`, "npm install"].join("\n"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("unclosed code fence");
  });

  it("counts an indented fence but not a four-space one", () => {
    // Up to three spaces is still a fence in CommonMark; four makes it an indented code
    // block, where the backticks are literal text.
    expect(zipWith(["# D", "", `   ${FENCE}`, "x", `   ${FENCE}`].join("\n")).ok).toBe(true);
    expect(zipWith(["# D", "", `    ${FENCE}`, "just literal text"].join("\n")).ok).toBe(true);
  });

  it("is not fooled by prose that pairs up around a real unclosed fence", () => {
    const readme = [
      "# D",
      `Use ${FENCE} to open and ${FENCE} to close.`,
      "",
      `${FENCE}bash`,
      "npm i",
    ].join("\n");

    expect(zipWith(readme).ok).toBe(false);
  });
});
