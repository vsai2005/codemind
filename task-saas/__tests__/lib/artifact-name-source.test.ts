import { describe, it, expect } from "vitest";
import { parseArtifactOutput } from "@/lib/artifacts/parse";
import { validateArtifact } from "@/lib/artifacts/validate";

/**
 * Where an artifact's filename came from.
 *
 * THE GAP THIS CLOSES. The parser recovers from several malformed opening tags, and one
 * of those recoveries invents a name because the model never emitted one. Nothing
 * recorded which had happened, so a persisted artifact called "project.zip" was
 * indistinguishable from one the model deliberately named that.
 *
 * MEASURED CONSEQUENCE: in the arm B run of 2026-09-03, zip-markdown-tool and
 * zip-prisma-api both persisted as "project.zip" while their real filenames --
 * markdown-to-html.zip and node-prisma-api.zip -- sat in the output behind an orphan
 * quote. Both reported ok=true with full check coverage. They were indistinguishable
 * from clean passes in every metric that existed.
 *
 * The three-way split is the point. A name read out of a MALFORMED tag is still the
 * model's own choice and is as trustworthy as a canonical one; only the invented one is
 * not. Collapsing "model-recovered" into either neighbour loses exactly that.
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

describe("a name the model wrote properly", () => {
  it("is recorded as the model's own", () => {
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" name="todo-cli.zip">')
    );

    expect(out.artifact?.nameSource).toBe("model");
    expect(out.artifact?.name).toBe("todo-cli.zip");
  });
});

describe("a name read out of a malformed tag", () => {
  /**
   * Still the model's choice, so still trustworthy — but distinguishable, because the
   * shape of the tag it came from is itself a signal worth being able to count.
   */
  it("is recorded as recovered when the attribute syntax is missing", () => {
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" nodejs-typescript-todo-cli.zip>')
    );

    expect(out.artifact?.nameSource).toBe("model-recovered");
    expect(out.artifact?.name).toBe("nodejs-typescript-todo-cli.zip");
  });

  it("is recorded as recovered behind an orphan closing quote", () => {
    /**
     * MEASURED, arm B 2026-09-03. Two turns emitted the closing quote of a `name="`
     * that was never opened, matched no pattern, and fell through to synthesis --
     * persisting as "project.zip" with the real filename sitting in the tag.
     */
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" markdown-to-html.zip">')
    );

    expect(out.artifact?.nameSource).toBe("model-recovered");
    expect(out.artifact?.name).toBe("markdown-to-html.zip");
  });

  it("does not fall through to synthesis for that shape", () => {
    // MUTATION GUARD stated as the consequence rather than the mechanism: the whole
    // point is that a recoverable name stops being replaced by an invented one.
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" node-prisma-api.zip">')
    );

    expect(out.artifact?.name).not.toBe("project.zip");
    expect(out.artifact?.nameSource).not.toBe("synthesized");
  });

  it("is recorded as recovered when the name is emitted twice", () => {
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" markdown-to-html.zip" name="markdown-to-html.zip">')
    );

    expect(out.artifact?.nameSource).toBe("model-recovered");
    expect(out.artifact?.name).toBe("markdown-to-html.zip");
  });

  it("is NOT reported as the model writing it properly", () => {
    /**
     * MUTATION GUARD, and the distinction the whole field exists for. If a recovered
     * name were labelled "model", the malformed-tag rate would read as zero and there
     * would be no way to notice the parser leaning on recovery more and more.
     */
    const out = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" react-vite-counter.zip>')
    );

    expect(out.artifact?.nameSource).not.toBe("model");
  });
});

describe("a name that did not exist", () => {
  const collapsed =
    "<codemind_summary>\nA blog.\n</codemind_artifact>\n" + zipBody + "\n</codemind_artifact>";

  it("is recorded as synthesized", () => {
    const out = parseArtifactOutput(collapsed);

    expect(out.artifact?.nameSource).toBe("synthesized");
    expect(out.artifact?.name).toBe("project.zip");
  });

  it("is NOT recorded as anything the model chose", () => {
    // MUTATION GUARD. This is the one value that means "do not trust this name", and
    // labelling it either of the others would defeat the entire field.
    const source = parseArtifactOutput(collapsed).artifact?.nameSource;

    expect(source).not.toBe("model");
    expect(source).not.toBe("model-recovered");
  });
});

describe("surviving validation", () => {
  /**
   * Validation may REJECT a name, but it must never re-source one. A provenance that
   * resets to "model" on the way through would be worse than not recording it at all,
   * because it would look authoritative.
   */
  it("carries a synthesized source through to the normalized artifact", () => {
    const parsed = parseArtifactOutput(
      "<codemind_summary>\nA blog.\n</codemind_artifact>\n" + zipBody + "\n</codemind_artifact>"
    );
    const result = validateArtifact(parsed.artifact as never, "zip");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifact.nameSource).toBe("synthesized");
  });

  it("carries a recovered source through unchanged", () => {
    const parsed = parseArtifactOutput(
      envelope('<codemind_artifact type="zip" python-web-scraper.zip>')
    );
    const result = validateArtifact(parsed.artifact as never, "zip");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.nameSource).toBe("model-recovered");
      expect(result.artifact.filename).toBe("python-web-scraper.zip");
    }
  });

  it("carries a canonical source through unchanged", () => {
    const parsed = parseArtifactOutput(envelope('<codemind_artifact type="zip" name="ok.zip">'));
    const result = validateArtifact(parsed.artifact as never, "zip");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifact.nameSource).toBe("model");
  });
});
