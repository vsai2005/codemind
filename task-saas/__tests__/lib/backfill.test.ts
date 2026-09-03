import { describe, it, expect } from "vitest";
import { parseAllArtifactBlocks } from "@/lib/artifacts/parse";
import {
  exciseArtifacts,
  stripOrphanFileBlocks,
  synthesizeContent,
  buildReplacementContent,
  INCOMPLETE_ARTIFACT_NOTE,
} from "@/lib/artifacts/backfill";
import type { NormalizedArtifact } from "@/lib/artifacts/types";

const zip: NormalizedArtifact = {
  type: "zip",
  filename: "demo.zip",
  files: [
    { path: "a.ts", content: "1" },
    { path: "b.ts", content: "2" },
  ],
  nameSource: "model",
};

describe("parseAllArtifactBlocks", () => {
  it("locates a single closed block with its exact span", () => {
    const content = `Here you go.

<codemind_artifact type="zip" name="demo.zip">
<file path="a.ts">export const a = 1;</file>
</codemind_artifact>

Enjoy.`;

    const { blocks, errors } = parseAllArtifactBlocks(content);
    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].artifact.name).toBe("demo.zip");
    expect(blocks[0].artifact.files).toHaveLength(1);
    expect(content.slice(blocks[0].start, blocks[0].end)).toMatch(/^<codemind_artifact/);
    expect(content.slice(blocks[0].start, blocks[0].end)).toMatch(/<\/codemind_artifact>$/);
  });

  it("locates multiple blocks in one message", () => {
    const content = `<codemind_artifact type="file" name="a.ts">export const a = 1;</codemind_artifact>
between
<codemind_artifact type="file" name="b.ts">export const b = 2;</codemind_artifact>`;

    const { blocks, errors } = parseAllArtifactBlocks(content);
    expect(errors).toEqual([]);
    expect(blocks.map((b) => b.artifact.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("handles a legacy self-closing pdf tag", () => {
    const { blocks, errors } = parseAllArtifactBlocks(
      'Explanation here.\n<codemind_artifact type="pdf" name="doc.pdf" />'
    );
    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].selfClosing).toBe(true);
    expect(blocks[0].artifact.body).toBe("");
  });

  it("reports an unterminated block rather than returning it", () => {
    const content = `<codemind_artifact type="zip" name="cut.zip">
<file path="a.ts">export const a =`;

    const { blocks, errors, unterminatedStart } = parseAllArtifactBlocks(content);
    expect(blocks).toHaveLength(0);
    expect(errors.join(" ")).toMatch(/never closed/);
    expect(unterminatedStart).toBe(0);
  });

  it("reports where an unterminated block begins so callers can drop the remainder", () => {
    const prose = "Here is your project.\n\n";
    const content = `${prose}<codemind_artifact type="zip" name="cut.zip">
<file path="a.ts">export const a =`;

    const { unterminatedStart } = parseAllArtifactBlocks(content);
    expect(unterminatedStart).toBe(prose.length);
    expect(content.slice(0, unterminatedStart!)).toBe(prose);
  });

  it("keeps earlier complete blocks when a later one is unterminated", () => {
    const content = `<codemind_artifact type="file" name="a.ts">export const a = 1;</codemind_artifact>
<codemind_artifact type="zip" name="cut.zip">
<file path="b.ts">export const b =`;

    const { blocks, errors, unterminatedStart } = parseAllArtifactBlocks(content);
    expect(blocks.map((b) => b.artifact.name)).toEqual(["a.ts"]);
    expect(errors.join(" ")).toMatch(/never closed/);
    expect(unterminatedStart).toBeGreaterThan(0);
  });

  it("reports unclosed file blocks inside a closed artifact", () => {
    const content = `<codemind_artifact type="zip" name="cut.zip">
<file path="a.ts">ok</file>
<file path="b.ts">truncated
</codemind_artifact>`;

    const { blocks, errors } = parseAllArtifactBlocks(content);
    expect(blocks).toHaveLength(0);
    expect(errors.join(" ")).toMatch(/unclosed file block/);
  });

  it("returns nothing for content with no artifacts", () => {
    expect(parseAllArtifactBlocks("just prose")).toEqual({
      blocks: [],
      errors: [],
      unterminatedStart: null,
    });
  });
});

describe("exciseArtifacts", () => {
  it("removes blocks and keeps the surrounding prose", () => {
    const content = `Here you go.

<codemind_artifact type="zip" name="demo.zip">
<file path="a.ts">export const a = 1;</file>
</codemind_artifact>

Enjoy.`;

    const { blocks } = parseAllArtifactBlocks(content);
    expect(exciseArtifacts(content, blocks)).toBe("Here you go.\n\nEnjoy.");
  });

  it("removes every block when there are several", () => {
    const content = `A
<codemind_artifact type="file" name="a.ts">x</codemind_artifact>
B
<codemind_artifact type="file" name="b.ts">y</codemind_artifact>
C`;

    const { blocks } = parseAllArtifactBlocks(content);
    const result = exciseArtifacts(content, blocks);
    expect(result).not.toMatch(/codemind_artifact/);
    expect(result).toBe("A\n\nB\n\nC");
  });

  it("returns empty string when the message was only an artifact", () => {
    const content = '<codemind_artifact type="file" name="a.ts">x</codemind_artifact>';
    const { blocks } = parseAllArtifactBlocks(content);
    expect(exciseArtifacts(content, blocks)).toBe("");
  });

  it("drops dead markup after an unterminated tag when truncated at its start", () => {
    // Reproduces the real legacy shape: prose, then a project that was cut off.
    const content = `Here is your finished project.

<codemind_artifact type="zip" name="cut.zip">
<file path="package.json">{"name":"x"}</file>
<file path="tailwind.config.ts">const config: Config =

continue`;

    const { blocks, unterminatedStart } = parseAllArtifactBlocks(content);
    const base = unterminatedStart !== null ? content.slice(0, unterminatedStart) : content;
    const prose = exciseArtifacts(base, blocks);

    expect(prose).toBe("Here is your finished project.");
    expect(prose).not.toMatch(/codemind_artifact/);
    expect(prose).not.toMatch(/<file path=/);
    expect(prose).not.toMatch(/continue/);
    expect(prose.length).toBeLessThan(content.length);
  });
});

describe("stripOrphanFileBlocks", () => {
  it("removes closed bare file blocks and counts them", () => {
    const content = `Continuing.
<file path="a.ts">export const a = 1;</file>
<file path="b.ts">export const b = 2;</file>`;

    const result = stripOrphanFileBlocks(content);
    expect(result.count).toBe(2);
    expect(result.text).toBe("Continuing.");
    expect(result.text).not.toMatch(/<file path=/);
  });

  it("removes a trailing block whose closing tag never arrived", () => {
    // The real shape of a "continue" reply that was cut off again.
    const content = `<file path="a.ts">export const a = 1;</file>
<file path="tailwind.config.ts">const config: Config =

continue`;

    const result = stripOrphanFileBlocks(content);
    expect(result.count).toBe(2);
    expect(result.text).toBe("");
  });

  it("leaves ordinary prose untouched", () => {
    const result = stripOrphanFileBlocks("Just a normal answer with no markup.");
    expect(result.count).toBe(0);
    expect(result.text).toBe("Just a normal answer with no markup.");
  });

  it("does not touch files already removed as part of a real artifact", () => {
    const content = `Intro.
<codemind_artifact type="zip" name="demo.zip">
<file path="a.ts">export const a = 1;</file>
</codemind_artifact>`;

    const { blocks } = parseAllArtifactBlocks(content);
    // exciseArtifacts runs first, so the artifact's own files are already gone.
    const result = stripOrphanFileBlocks(exciseArtifacts(content, blocks));
    expect(result.count).toBe(0);
    expect(result.text).toBe("Intro.");
  });
});

describe("synthesizeContent", () => {
  it("describes each artifact type", () => {
    expect(synthesizeContent([zip])).toBe("Your project is ready — demo.zip contains 2 files.");
    expect(
      synthesizeContent([
        { type: "pdf", filename: "d.pdf", files: [], markdown: "x", nameSource: "model" },
      ])
    ).toBe(
      "Your document d.pdf is ready."
    );
    expect(
      synthesizeContent([
        { type: "file", filename: "m.ts", files: [{ path: "m.ts", content: "x" }], nameSource: "model" },
      ])
    ).toBe("I created m.ts.");
  });

  it("uses singular wording for a one-file project", () => {
    expect(synthesizeContent([{ ...zip, files: [{ path: "a.ts", content: "1" }] }])).toMatch(
      /contains 1 file\./
    );
  });
});

describe("buildReplacementContent", () => {
  it("prefers the author's surviving prose", () => {
    const result = buildReplacementContent({
      prose: "Here is the finished project, ready to run.",
      recovered: [zip],
      unrecoverableCount: 0,
    });
    expect(result).toBe("Here is the finished project, ready to run.");
  });

  it("synthesizes a line when prose is too short to stand alone", () => {
    const result = buildReplacementContent({ prose: "ok", recovered: [zip], unrecoverableCount: 0 });
    expect(result).toBe("Your project is ready — demo.zip contains 2 files.");
  });

  it("appends an honest note when something was unrecoverable", () => {
    const result = buildReplacementContent({
      prose: "Here is the finished project, ready to run.",
      recovered: [],
      unrecoverableCount: 1,
    });
    expect(result).toContain("Here is the finished project");
    expect(result).toContain(INCOMPLETE_ARTIFACT_NOTE);
  });

  it("never returns an empty body", () => {
    expect(
      buildReplacementContent({ prose: "", recovered: [], unrecoverableCount: 1 })
    ).toBe(INCOMPLETE_ARTIFACT_NOTE);

    expect(
      buildReplacementContent({ prose: "", recovered: [], unrecoverableCount: 0 })
    ).toBe(INCOMPLETE_ARTIFACT_NOTE);

    expect(buildReplacementContent({ prose: "", recovered: [zip], unrecoverableCount: 0 })).toBe(
      "Your project is ready — demo.zip contains 2 files."
    );
  });

  it("produces content free of artifact markup", () => {
    const content = `Intro text that is long enough.
<codemind_artifact type="zip" name="demo.zip">
<file path="a.ts">export const a = 1;</file>
</codemind_artifact>`;
    const { blocks } = parseAllArtifactBlocks(content);
    const result = buildReplacementContent({
      prose: exciseArtifacts(content, blocks),
      recovered: [zip],
      unrecoverableCount: 0,
    });

    expect(result).not.toMatch(/<codemind_artifact/);
    expect(result).not.toMatch(/<file path=/);
  });
});
