import { describe, it, expect } from "vitest";
import { validateArtifact, findTruncation, findSecretLeak } from "@/lib/artifacts/validate";
import { parseArtifactOutput } from "@/lib/artifacts/parse";
import type { RawArtifact } from "@/lib/artifacts/parse";

function zipArtifact(files: Array<{ path: string; content: string }>): RawArtifact {
  return { type: "zip", name: "project.zip", files, body: "", nameSource: "model" };
}

describe("findTruncation", () => {
  it("accepts complete files", () => {
    expect(findTruncation("index.ts", "export const a = 1;\n")).toBeNull();
    expect(findTruncation("package.json", '{\n  "name": "x"\n}\n')).toBeNull();
    expect(findTruncation("README.md", "# Title\n\nSome prose.\n")).toBeNull();
  });

  it("catches the reported failure mode: a file ending in 'continue'", () => {
    const content = "import type { Config } from 'tailwindcss';\n\nconst config: Config =\n\ncontinue";
    expect(findTruncation("tailwind.config.ts", content)).toMatch(/continuation marker/);
  });

  it("catches a dangling assignment", () => {
    expect(findTruncation("config.ts", "const config: Config =")).toMatch(/mid-statement/);
    expect(findTruncation("a.ts", "const xs = [1, 2,")).not.toBeNull();
  });

  it("catches unclosed brackets", () => {
    const content = "export function go() {\n  if (true) {\n    doThing();\n";
    expect(findTruncation("a.ts", content)).toMatch(/unclosed brace/);
  });

  it("does not flag braces that appear inside strings or comments", () => {
    const content = 'const s = "{{{";\n// } } }\n/* { */\nexport default s;\n';
    expect(findTruncation("a.ts", content)).toBeNull();
  });

  it("catches ellipsis and placeholder endings", () => {
    expect(findTruncation("a.ts", "const a = 1;\n...")).not.toBeNull();
    expect(findTruncation("a.ts", "const a = 1;\nrest of the code omitted")).not.toBeNull();
  });

  it("catches unclosed markdown code fences", () => {
    expect(findTruncation("README.md", "# Hi\n\n```ts\nconst a = 1;\n")).toMatch(/unclosed code fence/);
  });

  it("catches empty files", () => {
    expect(findTruncation("a.ts", "")).toMatch(/empty/);
    expect(findTruncation("a.ts", "   \n  ")).toMatch(/empty/);
  });
});

describe("findSecretLeak", () => {
  it("blocks live NVIDIA keys anywhere in content", () => {
    const leak = findSecretLeak("config.ts", 'const k = "nvapi-AbCdEf0123456789AbCdEf0123456789";');
    expect(leak).toMatch(/live API key/);
  });

  it("blocks real .env files but allows .env.example placeholders", () => {
    expect(findSecretLeak(".env", "ANY=thing")).toMatch(/environment file/);
    expect(findSecretLeak(".env.local", "ANY=thing")).not.toBeNull();
    expect(findSecretLeak(".env.example", 'AUTH_SECRET="your-secret-here"')).toBeNull();
    expect(findSecretLeak(".env.example", "DATABASE_URL=")).toBeNull();
  });

  it("blocks substantive assigned secrets but not placeholders", () => {
    expect(findSecretLeak("a.ts", 'AUTH_SECRET="k39fJqZ2mWx8Lp0aQr7Bn4Vt6Yc1Hd5S"')).not.toBeNull();
    expect(findSecretLeak("a.ts", 'AUTH_SECRET="changeme"')).toBeNull();
    expect(findSecretLeak("a.ts", 'AUTH_SECRET="your-auth-secret-here"')).toBeNull();
  });

  it("allows ordinary source", () => {
    expect(findSecretLeak("index.ts", "export const a = 1;")).toBeNull();
  });
});

describe("validateArtifact", () => {
  it("accepts a complete project", () => {
    const result = validateArtifact(
      zipArtifact([
        { path: "package.json", content: '{\n  "name": "demo"\n}' },
        { path: "src/index.ts", content: "export const go = () => 1;" },
      ]),
      "zip"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.files).toHaveLength(2);
      expect(result.artifact.filename).toBe("project.zip");
    }
  });

  it("refuses to package a project containing a truncated file", () => {
    const result = validateArtifact(
      zipArtifact([
        { path: "package.json", content: '{\n  "name": "demo"\n}' },
        { path: "tailwind.config.ts", content: "const config: Config =\n\ncontinue" },
      ]),
      "zip"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/continuation marker/);
  });

  it("rejects the whole archive when any path is unsafe", () => {
    const result = validateArtifact(
      zipArtifact([
        { path: "package.json", content: "{}" },
        { path: "../../etc/passwd", content: "root:x:0:0" },
      ]),
      "zip"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/rejected path/);
  });

  it("rejects duplicate paths, case-insensitively", () => {
    const result = validateArtifact(
      zipArtifact([
        { path: "src/App.tsx", content: "export default 1;" },
        { path: "src/app.tsx", content: "export default 2;" },
      ]),
      "zip"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/duplicate/);
  });

  it("rejects an artifact with no files", () => {
    expect(validateArtifact(zipArtifact([]), "zip")).toMatchObject({ ok: false });
  });

  it("enforces the filename extension for the type", () => {
    const bad: RawArtifact = {
      type: "zip",
      name: "project.tar",
      files: [],
      body: "",
      nameSource: "model",
    };
    expect(validateArtifact(bad, "zip")).toMatchObject({ ok: false });
  });

  it("requires exactly one file for a single-file artifact", () => {
    const raw: RawArtifact = {
      type: "file",
      name: "middleware.ts",
      files: [
        { path: "middleware.ts", content: "export const a = 1;" },
        { path: "extra.ts", content: "export const b = 2;" },
      ],
      body: "",
      nameSource: "model",
    };
    expect(validateArtifact(raw, "file")).toMatchObject({ ok: false });
  });

  it("does not trust the model's declared type over server intent", () => {
    const raw: RawArtifact = {
      type: "file",
      name: "x.zip",
      files: [],
      body: "",
      nameSource: "model",
    };
    const result = validateArtifact(raw, "zip");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/expected a zip artifact/);
  });
});

describe("parseArtifactOutput", () => {
  it("parses a well-formed zip artifact and its summary", () => {
    const output = `<codemind_summary>Built a tiny app.</codemind_summary>
<codemind_artifact type="zip" name="tiny.zip">
<file path="package.json">
{"name":"tiny"}
</file>
<file path="src/index.ts">
export const a = 1;
</file>
</codemind_artifact>`;

    const result = parseArtifactOutput(output);
    expect(result.errors).toEqual([]);
    expect(result.summary).toBe("Built a tiny app.");
    expect(result.artifact?.files).toHaveLength(2);
    expect(result.artifact?.files[0].path).toBe("package.json");
  });

  it("reports an unclosed artifact block instead of salvaging it", () => {
    const output = `<codemind_artifact type="zip" name="tiny.zip">
<file path="package.json">
{"name":"tiny"}
</file>
<file path="src/index.ts">
export const a =`;

    const result = parseArtifactOutput(output);
    expect(result.artifact).toBeNull();
    expect(result.errors.join(" ")).toMatch(/never closed/);
  });

  it("reports an unclosed file block", () => {
    const output = `<codemind_artifact type="zip" name="tiny.zip">
<file path="a.ts">
export const a = 1;
</file>
<file path="b.ts">
export const b =
</codemind_artifact>`;

    const result = parseArtifactOutput(output);
    expect(result.errors.join(" ")).toMatch(/never closed/);
  });

  it("reports missing artifact markup", () => {
    const result = parseArtifactOutput("Sure! Here is some prose instead.");
    expect(result.artifact).toBeNull();
    expect(result.errors.join(" ")).toMatch(/did not produce an artifact/);
  });
});
