import { describe, it, expect } from "vitest";
import { maskNonCode, MASK_FILL } from "@/lib/repo/mask-code";
import { scanImports } from "@/lib/repo/imports";
import { verifyArtifact } from "@/lib/artifacts/verify";
import type { NormalizedArtifact } from "@/lib/artifacts/types";

/**
 * Masking comments and literals before scanning for imports.
 *
 * WHY THIS IS A BLOCKING-SEVERITY BUG AND NOT TIDYING
 * A specifier found inside a comment used to be a spurious EDGE — noise in a retrieval
 * graph. Once verification began blocking on unresolvable specifiers, the same noise
 * became a refusal of a valid project, with nothing the user could do about it. The
 * cases below were reproduced against the unmasked scanner before this was written:
 * every one of them produced a specifier.
 *
 * FIXTURES ARE NAMED ADVERSARIALLY. Every fake path ends in "-fake" and every real one
 * in "-real", so an assertion cannot pass by matching the wrong thing, and a reader can
 * see at a glance which side a failure fell on.
 */

const project = (files: Record<string, string>): NormalizedArtifact => ({
  type: "zip",
  filename: "project.zip",
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  nameSource: "model",
});

const specifiers = (source: string): string[] => scanImports(source).specifiers;

describe("the five false positives", () => {
  it("ignores a commented-out require", () => {
    expect(specifiers(`// const legacy = require("./old-fake");\nexport const a = 1;`)).toEqual([]);
  });

  it("ignores a require inside a block comment", () => {
    expect(
      specifiers(`/*\n  const x = require("./block-fake");\n*/\nexport const b = 2;`)
    ).toEqual([]);
  });

  it("ignores an import shown in a JSDoc example", () => {
    expect(
      specifiers(`/**\n * @example const a = require("./jsdoc-fake");\n */\nexport function f() {}`)
    ).toEqual([]);
  });

  it("ignores a require written inside a string literal", () => {
    expect(specifiers(`const snippet = "require('./string-fake')";\nexport const c = snippet;`)).toEqual(
      []
    );
  });

  it("ignores an import inside a template literal", () => {
    // A code generator emitting source is the realistic form of this: the template
    // contains a whole import statement at the start of a line, which is exactly what
    // the line-anchored patterns look for.
    //
    // No fence here on purpose. An earlier fixture put an unescaped markdown fence
    // inside the template, which is not valid TypeScript — a raw backtick CLOSES the
    // template — so the masker was right and the fixture was wrong. The fence case
    // lives in the JSDoc test below, which is where fences realistically appear.
    const source = [
      "const generated = `",
      'import { demo } from "./fence-fake";',
      "export const x = demo;",
      "`;",
    ].join("\n");

    expect(specifiers(source)).toEqual([]);
  });

  it("ignores a markdown fence inside a JSDoc block", () => {
    // The realistic form of the same hazard: documentation showing an import that
    // no longer exists, or never did.
    const source = [
      "/**",
      " * Usage:",
      " * ```ts",
      ' * import { thing } from "./doc-fake";',
      " * ```",
      " */",
      'import { real } from "./doc-real";',
    ].join("\n");

    expect(specifiers(source)).toEqual(["./doc-real"]);
  });

  it("ignores a dynamic import in a comment", () => {
    expect(specifiers(`// await import("./dynamic-fake");\nexport const d = 4;`)).toEqual([]);
  });
});

describe("real imports still survive", () => {
  it("extracts the import on the line after a commented-out one", () => {
    // The regression this must not cause: masking a comment must not swallow the code
    // beneath it.
    expect(
      specifiers(`// import { old } from "./gone-fake";\nimport { real } from "./next-real";`)
    ).toEqual(["./next-real"]);
  });

  it("extracts a real require after a fake one written in a string", () => {
    expect(
      specifiers(`const s = "require('./string-fake')";\nconst r = require("./after-real");`)
    ).toEqual(["./after-real"]);
  });

  it("keeps a trailing comment from hiding the import it follows", () => {
    expect(
      specifiers(`import { real } from "./trailing-real"; // import x from "./comment-fake";`)
    ).toEqual(["./trailing-real"]);
  });

  it("reads a specifier containing a comment marker", () => {
    // "//" inside the specifier is part of a path, not the start of a comment. Masking
    // that would silently drop a legitimate protocol-relative or URL-ish import.
    expect(specifiers(`import x from "https://esm.sh/real-pkg";`)).toEqual([
      "https://esm.sh/real-pkg",
    ]);
  });

  it("reads a specifier containing an escaped quote", () => {
    expect(specifiers(`const a = require("./odd\\"name-real");`)).toEqual([`./odd\\"name-real`]);
  });
});

describe("constructs the masker must not be confused by", () => {
  it("handles a regex literal containing quote characters", () => {
    // Left as code, the quote inside the regex opens a bogus string that swallows the
    // import below it.
    const source = [`const re = /["']/;`, `import { real } from "./after-regex-real";`].join("\n");

    expect(specifiers(source)).toEqual(["./after-regex-real"]);
  });

  it("handles a regex literal containing a comment marker", () => {
    const source = [`const re = /\\/\\//;`, `import { real } from "./after-slashes-real";`].join(
      "\n"
    );

    expect(specifiers(source)).toEqual(["./after-slashes-real"]);
  });

  it("masks a regex containing a BACKTICK, which would otherwise open a template", () => {
    // Isolates regex handling from the newline rule. A stray double quote inside a
    // regex is contained by the "strings do not span lines" rule, so the two mechanisms
    // covered for each other and neither mutation failed a test. A backtick is not
    // contained by it — templates DO span lines — so only regex masking saves this.
    const source = [
      "const re = /[`]/;",
      'import { real } from "./after-backtick-regex-real";',
    ].join("\n");

    expect(specifiers(source)).toEqual(["./after-backtick-regex-real"]);
  });

  it("stops an unterminated string at the end of its line", () => {
    // Isolates the newline rule. Real files are sometimes malformed — ingestion reads
    // whatever GitHub returns — and without this one stray quote masks everything up to
    // the next quote, losing every import in between. Bounded masking keeps the damage
    // to the line that is actually broken.
    const source = [
      'const broken = "oops;',
      'import { real } from "./after-unterminated-real";',
    ].join("\n");

    expect(specifiers(source)).toEqual(["./after-unterminated-real"]);
  });

  it("handles a comment marker inside a string", () => {
    const source = [`const s = "// not a comment";`, `import { real } from "./after-str-real";`].join(
      "\n"
    );

    expect(specifiers(source)).toEqual(["./after-str-real"]);
  });

  it("handles a quote inside a comment", () => {
    // An apostrophe in prose must not open a string that eats the rest of the file.
    const source = [`// it's a helper`, `import { real } from "./after-apostrophe-real";`].join("\n");

    expect(specifiers(source)).toEqual(["./after-apostrophe-real"]);
  });

  it("handles template interpolation containing a nested string", () => {
    const source = [
      "const t = `value: ${obj[\"key\"]} end`;",
      `import { real } from "./after-interp-real";`,
    ].join("\n");

    expect(specifiers(source)).toEqual(["./after-interp-real"]);
  });
});

describe("offsets and counts are preserved", () => {
  it("returns a string of exactly the same length", () => {
    // The property everything else rests on: the caller matches against the masked copy
    // and slices the original at the same offsets. A length change would silently
    // return the wrong text as a specifier.
    for (const source of [
      `import a from "./x";\n// comment\nconst s = 'text';`,
      "const t = `multi\nline ${a} template`;\n",
      `/* block\n   comment */\nconst re = /["']/;`,
      "",
    ]) {
      expect(maskNonCode(source)).toHaveLength(source.length);
    }
  });

  it("keeps newlines, so line-anchored patterns see the same line structure", () => {
    const source = `/*\n\n*/\nimport a from "./real";`;
    const masked = maskNonCode(source);

    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("replaces literal interiors but keeps their delimiters", () => {
    const masked = maskNonCode(`const s = "abc";`);

    expect(masked).toBe(`const s = "${MASK_FILL.repeat(3)}";`);
  });

  it("does not count a commented-out dynamic require as an unread construct", () => {
    // unread counts constructs the scanner cannot follow. A commented one is not a
    // construct at all, and counting it would warn about code that does not run.
    expect(scanImports(`// const x = require(base + "/y");\nexport const a = 1;`).unread).toBe(0);
    expect(scanImports(`const x = require(base + "/y");`).unread).toBe(1);
  });
});

describe("regressions that must not be reintroduced", () => {
  const CLEAN = {
    "package.json": JSON.stringify({ name: "demo", dependencies: {} }),
    "src/index.ts": `import { helper } from "./helper";\nexport const app = helper;`,
    "src/helper.ts": `export const helper = 1;`,
  };

  it("no longer blocks an artifact whose only bad specifier is in a comment", () => {
    // The regression the previous change introduced: this artifact is valid and was
    // being refused.
    const report = verifyArtifact(
      project({
        ...CLEAN,
        "src/index.ts": `// const removed = require("./deleted-fake");\nimport { helper } from "./helper";\nexport const app = helper;`,
      })
    );

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("still fails an artifact with a genuinely unresolvable import", () => {
    const report = verifyArtifact(
      project({ ...CLEAN, "src/index.ts": `import { db } from "./lib/db-real";\nexport const a = db;` })
    );

    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain("unresolved-internal-import");
  });

  it("still fails the deliberate 206-import case", () => {
    // The truncation guarantee from the previous change, unaffected by masking.
    const generated: Record<string, string> = { ...CLEAN };
    const lines: string[] = [];
    for (let i = 0; i < 205; i++) {
      generated[`src/generated/mod${i}.ts`] = `export const thing${i} = ${i};`;
      lines.push(`import { thing${i} } from "./generated/mod${i}";`);
    }
    lines.push(`import { missing } from "./never-generated-real";`);
    generated["src/index.ts"] = lines.join("\n");

    const report = verifyArtifact(project(generated));

    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.code)).toContain("imports-unreadable");
  });
});
