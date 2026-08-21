import { describe, it, expect } from "vitest";
import {
  validateArtifactPath,
  validateArtifactFilename,
  contentDisposition,
} from "@/lib/artifacts/paths";

describe("validateArtifactPath", () => {
  it("accepts ordinary project paths", () => {
    for (const path of [
      "package.json",
      "src/index.ts",
      "src/app/(marketing)/page.tsx",
      "prisma/schema.prisma",
      "a/b/c/d/e/file.txt",
      ".github/workflows/ci.yml",
      ".env.example",
    ]) {
      const result = validateArtifactPath(path);
      expect(result, `expected ${path} to be accepted`).toMatchObject({ ok: true });
    }
  });

  it("drops no-op './' prefixes without altering the target", () => {
    expect(validateArtifactPath("./src/index.ts")).toEqual({ ok: true, value: "src/index.ts" });
    expect(validateArtifactPath("src/./index.ts")).toEqual({ ok: true, value: "src/index.ts" });
  });

  describe("rejects traversal attacks", () => {
    const attacks = [
      "../secret.txt",
      "../../etc/passwd",
      "../../../../../../etc/shadow",
      "..\\secret.txt",
      "..\\..\\windows\\system32",
      "C:\\secret.txt",
      "c:/secret.txt",
      "/var/secrets/file",
      "/etc/passwd",
      "\\\\server\\share\\file",
      "src/../../../etc/passwd",
      "foo/../../bar",
    ];

    for (const attack of attacks) {
      it(`rejects ${JSON.stringify(attack)}`, () => {
        expect(validateArtifactPath(attack)).toMatchObject({ ok: false });
      });
    }
  });

  it("rejects padded dot segments that defeat strip-once sanitizers", () => {
    // The original sanitizer did p.replace(/\.\.\//g, ""), which turns "....//"
    // back into "../". These must be rejected outright, not rewritten.
    for (const attack of ["....//", "....//etc/passwd", ".../", "..././"]) {
      expect(validateArtifactPath(attack), attack).toMatchObject({ ok: false });
    }
  });

  it("proves the old sanitizer was bypassable", () => {
    const sanitizeOldWay = (p: string) => p.replace(/^\/+/, "").replace(/\.\.\//g, "");
    expect(sanitizeOldWay("....//")).toBe("../");

    // The replacement validator rejects both the input and its collapsed form.
    expect(validateArtifactPath("....//")).toMatchObject({ ok: false });
    expect(validateArtifactPath("../")).toMatchObject({ ok: false });
  });

  it("rejects null bytes and control characters", () => {
    expect(validateArtifactPath("file\0.txt")).toMatchObject({ ok: false });
    expect(validateArtifactPath("file\n.txt")).toMatchObject({ ok: false });
    expect(validateArtifactPath("file\r\n.txt")).toMatchObject({ ok: false });
  });

  it("rejects percent-encoded traversal", () => {
    for (const attack of [
      "%2e%2e%2fsecret",
      "..%2fsecret",
      "%2e%2e/secret",
      "src%5c..%5csecret",
      "file%00.txt",
    ]) {
      expect(validateArtifactPath(attack), attack).toMatchObject({ ok: false });
    }
  });

  it("rejects empty segments and structurally invalid input", () => {
    for (const attack of ["", "   ", "a//b", "a/", "/", "~/secrets", "a/ b/c"]) {
      expect(validateArtifactPath(attack), JSON.stringify(attack)).toMatchObject({ ok: false });
    }
  });

  it("rejects non-strings and oversized paths", () => {
    expect(validateArtifactPath(null)).toMatchObject({ ok: false });
    expect(validateArtifactPath(42)).toMatchObject({ ok: false });
    expect(validateArtifactPath({})).toMatchObject({ ok: false });
    expect(validateArtifactPath("a/".repeat(300) + "f.txt")).toMatchObject({ ok: false });
    expect(validateArtifactPath("x".repeat(500))).toMatchObject({ ok: false });
  });
});

describe("validateArtifactFilename", () => {
  it("accepts normal download names", () => {
    expect(validateArtifactFilename("finance-tracker.zip", [".zip"])).toEqual({
      ok: true,
      value: "finance-tracker.zip",
    });
    expect(validateArtifactFilename("middleware.ts")).toMatchObject({ ok: true });
  });

  it("rejects path separators and traversal", () => {
    for (const name of ["../evil.zip", "a/b.zip", "a\\b.zip", "/etc/passwd", ".."]) {
      expect(validateArtifactFilename(name), name).toMatchObject({ ok: false });
    }
  });

  it("rejects characters that would break the Content-Disposition header", () => {
    for (const name of ['a".zip', "a;b.zip", "a\r\nb.zip", "a\0.zip"]) {
      expect(validateArtifactFilename(name), JSON.stringify(name)).toMatchObject({ ok: false });
    }
  });

  it("rejects reserved Windows device names", () => {
    expect(validateArtifactFilename("CON.zip")).toMatchObject({ ok: false });
    expect(validateArtifactFilename("nul")).toMatchObject({ ok: false });
  });

  it("enforces the expected extension", () => {
    expect(validateArtifactFilename("project.tar.gz", [".zip"])).toMatchObject({ ok: false });
    expect(validateArtifactFilename("report.pdf", [".pdf"])).toMatchObject({ ok: true });
  });

  it("never emits an unquoted or injectable header value", () => {
    expect(contentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    // A rejected name degrades to a safe constant rather than leaking into the header.
    expect(contentDisposition('evil";\r\nX-Injected: 1')).toBe('attachment; filename="download"');
  });
});
