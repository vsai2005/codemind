import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { parseArtifactOutput, parseAllArtifactBlocks } from "@/lib/artifacts/parse";
import { findTruncation } from "@/lib/artifacts/validate";

/**
 * Case-insensitive sentinel search that cannot disagree with the source.
 *
 * THE BUG THIS PINS DOWN
 * parse.ts computed the closing sentinel's position against `text.toLowerCase()` and
 * then sliced `text`. That is only safe while lowercasing preserves length, and it does
 * not: U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE) lowercases to TWO code units,
 * `i` + U+0307. Everything after it shifts by one, the slice runs one character too far,
 * and the leading `<` of `</codemind_artifact>` lands on the end of the file.
 *
 * EVERY FIXTURE HERE CONTAINS A GROWING CHARACTER, and that is the whole point. An
 * ASCII-only fixture produces identical output before and after the fix — it cannot
 * distinguish them at all, which is precisely how this shipped and survived a test
 * suite. Mutation testing confirms it: reverting either site leaves an ASCII suite
 * entirely green.
 *
 * `İ` is not an exotic choice. It appears in Turkish, and the generation that exposed
 * this was a slugify utility whose transliteration map naturally included it.
 */

/** U+0130. Verified here rather than asserted in prose. */
const GROWER = "İ";

describe("the premise", () => {
  it("confirms the character actually grows under lowercasing", () => {
    // If this ever stops being true the fixtures below silently stop testing anything.
    expect(GROWER.length).toBe(1);
    expect(GROWER.toLowerCase().length).toBe(2);
  });
});

const wrap = (body: string, name = "slugify.ts"): string =>
  `<codemind_summary>a utility</codemind_summary>\n` +
  `<codemind_artifact type="file" name="${name}">\n${body}\n</codemind_artifact>`;

const onlyFile = (raw: string) => {
  const parsed = parseArtifactOutput(raw);
  expect(parsed.errors).toEqual([]);
  expect(parsed.artifact).not.toBeNull();
  return parsed.artifact!.files[0];
};

describe("a growing character before the sentinel", () => {
  it("does not leak the sentinel's leading angle bracket into the file", () => {
    // THE DEFECT IN ONE ASSERTION. Before the fix this content ended with "<".
    const file = onlyFile(wrap(`const map = { "${GROWER}": "i" };\nexport default map;`));

    expect(file.content.endsWith("<")).toBe(false);
    expect(file.content.trimEnd().endsWith("export default map;")).toBe(true);
  });

  it("leaves the file passing the truncation check it used to fail", () => {
    // The checker was never wrong — it was handed a corrupted body. This asserts the
    // end-to-end consequence rather than only the parse.
    const file = onlyFile(wrap(`const map = { "${GROWER}": "i" };\nexport default map;`));

    expect(findTruncation(file.path, file.content)).toBeNull();
  });

  it("survives the character sitting immediately before the sentinel", () => {
    // Worst case for an off-by-one: the drift source is adjacent to the boundary.
    const file = onlyFile(wrap(`export const initial = "${GROWER}";`));

    // Trimmed: the parser preserves the newlines that bracket the body, which is
    // pre-existing behaviour and not what this test is about.
    expect(file.content.trim()).toBe(`export const initial = "${GROWER}";`);
  });

  it("survives many growing characters, where the drift is larger than one", () => {
    // Ten of them shift the index by ten, which eats the whole "</codemind" prefix.
    const body = `const m = "${GROWER.repeat(10)}";\nexport default m;`;
    const file = onlyFile(wrap(body));

    expect(file.content.trim()).toBe(body);
    expect(file.content).not.toMatch(/<\/?codemind/);
  });

  it("survives one in the filename attribute", () => {
    // The name is captured by a regex on the original string, but the body offset is
    // computed from that match — so a grower in the attribute shifts the body too.
    const parsed = parseArtifactOutput(
      wrap("export default 1;", `slug-${GROWER}.ts`)
    );

    expect(parsed.artifact!.files[0].content.trim()).toBe("export default 1;");
  });
});

describe("case-insensitivity is preserved", () => {
  it("still matches a sentinel written in mixed case", () => {
    // The lowercasing existed for a reason; removing it must not make the search
    // case-sensitive.
    const raw =
      `<codemind_artifact type="file" name="a.ts">\nexport default 1;\n</CODEMIND_ARTIFACT>`;
    const parsed = parseArtifactOutput(raw);

    expect(parsed.artifact!.files[0].content.trim()).toBe("export default 1;");
  });

  it("matches a mixed-case sentinel even with drift in the body", () => {
    // Both properties at once — the combination the old code could not satisfy.
    const raw =
      `<codemind_artifact type="file" name="a.ts">\nconst c = "${GROWER}";\n</CodeMind_Artifact>`;
    const parsed = parseArtifactOutput(raw);

    expect(parsed.artifact!.files[0].content.trim()).toBe(`const c = "${GROWER}";`);
  });

  it("stops at the FIRST sentinel, not a later one", () => {
    // A body mentioning the sentinel as literal text must not extend the block.
    const raw = `<codemind_artifact type="file" name="a.ts">\nexport default 1;\n</codemind_artifact>\ntrailing`;
    const parsed = parseArtifactOutput(raw);

    expect(parsed.artifact!.files[0].content.trim()).toBe("export default 1;");
  });

  it("still reports an unterminated block", () => {
    // The not-found path must survive the rewrite: no sentinel means the generation
    // stopped early, and that error is how a caller learns it.
    const parsed = parseArtifactOutput(
      `<codemind_artifact type="file" name="a.ts">\nconst c = "${GROWER}";`
    );

    expect(parsed.artifact).toBeNull();
    expect(parsed.errors.join(" ")).toMatch(/never closed/i);
  });
});

describe("the captured generations", () => {
  /**
   * The real bytes, kept by the harness change that preceded this fix. rep2 is the
   * generation that failed validation; rep1 is one that passed. Guarded on existence
   * because `.measure/` is local evidence and gitignored — a fresh clone runs the
   * synthetic fixtures above and skips these.
   */
  const load = (dir: string): string | null => {
    const p = `.measure/${dir}/A__single-slugify.raw.txt`;
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };

  it("parses the rejected rep2 output with no trailing angle bracket", () => {
    const raw = load("rep2");
    if (raw === null) return;

    // Sanity: these really are the drifting bytes.
    expect(raw.toLowerCase().length).toBe(raw.length + 1);

    const file = onlyFile(raw);
    expect(file.path).toBe("slugify.ts");
    expect(file.content.endsWith("<")).toBe(false);
    expect(findTruncation(file.path, file.content)).toBeNull();
  });

  it("leaves the passing rep1 output byte-identical", () => {
    const raw = load("rep1");
    if (raw === null) return;

    // No drift in this one, so the fix must be a no-op for it.
    expect(raw.toLowerCase().length).toBe(raw.length);

    const file = onlyFile(raw);
    expect(findTruncation(file.path, file.content)).toBeNull();
    expect(file.content.trimEnd().endsWith("export default slugify;")).toBe(true);
  });
});

describe("the multi-artifact path", () => {
  /**
   * parseAllArtifactBlocks had the SAME defect at its own site, and a worse consequence:
   * there `closeIndex` also produced `end`, the offset where scanning resumes. A shifted
   * end mis-sliced the FOLLOWING block as well as the current one, so drift in the first
   * artifact silently corrupted the second.
   *
   * Covered separately because nothing in parseArtifactOutput reaches this function —
   * fixing one site and not the other would have left every test above green.
   */
  const block = (name: string, body: string) =>
    `<codemind_artifact type="file" name="${name}">
${body}
</codemind_artifact>`;

  it("does not leak the sentinel into a body containing a growing character", () => {
    const { blocks, errors } = parseAllArtifactBlocks(
      block("a.ts", `const c = "${GROWER}";`)
    );

    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].artifact.files[0].content.trim()).toBe(`const c = "${GROWER}";`);
    expect(blocks[0].artifact.files[0].content.endsWith("<")).toBe(false);
  });

  it("keeps a SECOND block intact when the first one drifts", () => {
    // The compounding case. `end` from the first block is where the second is read
    // from, so a one-character shift there damages a block that contains no unusual
    // characters at all — corruption at a distance.
    const raw =
      block("first.ts", `const c = "${GROWER}";`) +
      `${"\n"}` +
      block("second.ts", "export default 2;");
    const { blocks, errors } = parseAllArtifactBlocks(raw);

    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].artifact.name).toBe("second.ts");
    expect(blocks[1].artifact.files[0].content.trim()).toBe("export default 2;");
    expect(blocks[1].artifact.files[0].content).not.toMatch(/codemind/);
  });

  it("reports the end offset inside the source string", () => {
    // `end` must be an offset into the ORIGINAL content. If it came from a lowercased
    // string it would point past the sentinel and slice from the wrong place.
    const raw = block("a.ts", `const c = "${GROWER}";`);
    const { blocks } = parseAllArtifactBlocks(raw);

    expect(blocks[0].end).toBe(raw.length);
    expect(raw.slice(blocks[0].end)).toBe("");
  });

  it("still matches a mixed-case closing sentinel", () => {
    const raw = `<codemind_artifact type="file" name="a.ts">
const c = "${GROWER}";
</CODEMIND_ARTIFACT>`;
    const { blocks } = parseAllArtifactBlocks(raw);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].artifact.files[0].content.trim()).toBe(`const c = "${GROWER}";`);
  });

  it("still flags an unterminated block", () => {
    const { errors, unterminatedStart } = parseAllArtifactBlocks(
      `<codemind_artifact type="file" name="a.ts">
const c = "${GROWER}";`
    );

    expect(errors.join(" ")).toMatch(/never closed/i);
    expect(unterminatedStart).toBe(0);
  });
});
