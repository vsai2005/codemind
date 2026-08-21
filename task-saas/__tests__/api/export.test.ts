import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    message: { findFirst: vi.fn() },
  },
}));

import { POST as exportZip } from "@/app/api/export/zip/route";
import { POST as exportFile } from "@/app/api/export/file/route";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { __resetRateLimits } from "@/lib/rate-limit";

function request(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

function zipRequest(body: unknown): Request {
  return request("http://localhost:3000/api/export/zip", body);
}

describe("Export APIs (legacy inline artifacts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimits();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
  });

  describe("ZIP Export", () => {
    it("returns 401 when unauthenticated", async () => {
      (auth as any).mockResolvedValue(null);
      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(401);
    });

    it("enforces ownership isolation", async () => {
      // The route scopes the lookup by userId, so another user's message is simply not found.
      (prisma.message.findFirst as any).mockResolvedValue(null);

      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(404);

      const where = (prisma.message.findFirst as any).mock.calls[0][0].where;
      expect(where.conversation.userId).toBe("user-1");
    });

    it("generates a ZIP with nested folder structure", async () => {
      (prisma.message.findFirst as any).mockResolvedValue({
        content: `
        <codemind_artifact type="zip" name="test.zip">
          <file path="package.json">{"name": "test"}</file>
          <file path="src/app.ts">console.log("hi")</file>
        </codemind_artifact>`,
      });

      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="test.zip"');

      const zip = await JSZip.loadAsync(await res.arrayBuffer());
      expect(Object.values(zip.files).filter((f) => !f.dir)).toHaveLength(2);
      expect(await zip.file("package.json")?.async("string")).toBe('{"name": "test"}');
      expect(await zip.file("src/app.ts")?.async("string")).toBe('console.log("hi")');
    });

    it("REJECTS the archive when any path traverses, rather than rewriting it", async () => {
      // The previous implementation stripped "../" and leading slashes, silently
      // relocating an attacker-chosen path into the archive. It now refuses outright.
      (prisma.message.findFirst as any).mockResolvedValue({
        content: `
        <codemind_artifact type="zip" name="test.zip">
          <file path="package.json">{"name":"ok"}</file>
          <file path="../../../etc/passwd">secret</file>
        </codemind_artifact>`,
      });

      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toMatch(/rejected path/i);
      // Nothing was packaged at all — not even under a rewritten name.
      expect(res.headers.get("Content-Type")).toMatch(/json/);
    });

    it("rejects absolute, Windows and UNC paths", async () => {
      for (const path of ["/absolute/path", "C:\\secret.txt", "..\\evil.txt", "\\\\srv\\s\\f"]) {
        (prisma.message.findFirst as any).mockResolvedValue({
          content: `<codemind_artifact type="zip" name="test.zip"><file path="${path}">x</file></codemind_artifact>`,
        });

        const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
        expect(res.status, path).toBe(400);
      }
    });

    it("refuses to build an archive containing a real secret", async () => {
      (prisma.message.findFirst as any).mockResolvedValue({
        content: `
        <codemind_artifact type="zip" name="test.zip">
          <file path="safe.txt">Hello world</file>
          <file path=".env">DATABASE_URL=postgres://u:p@h/db</file>
        </codemind_artifact>`,
      });

      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/environment file/i);
    });

    it("refuses to build an archive containing a live API key", async () => {
      (prisma.message.findFirst as any).mockResolvedValue({
        content: `
        <codemind_artifact type="zip" name="test.zip">
          <file path="config.ts">export const key = "nvapi-AbCdEf0123456789AbCdEf0123456789";</file>
        </codemind_artifact>`,
      });

      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/live API key/i);
    });

    it("still allows scaffolds that merely reference env vars", async () => {
      // Blocking every mention of DATABASE_URL would break almost any real project.
      (prisma.message.findFirst as any).mockResolvedValue({
        content: `
        <codemind_artifact type="zip" name="test.zip">
          <file path="lib/db.ts">const url = process.env.DATABASE_URL;
export default url;</file>
          <file path=".env.example">DATABASE_URL=
AUTH_SECRET="your-secret-here"</file>
        </codemind_artifact>`,
      });

      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "test.zip" }));
      expect(res.status).toBe(200);

      const zip = await JSZip.loadAsync(await res.arrayBuffer());
      expect(zip.file("lib/db.ts")).not.toBeNull();
      expect(zip.file(".env.example")).not.toBeNull();
    });

    it("rejects a malicious download filename", async () => {
      const res = await exportZip(zipRequest({ messageId: "msg1", filename: "../../evil.zip" }));
      expect(res.status).toBe(400);
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it("rejects a malformed body", async () => {
      const res = await exportZip(zipRequest({ messageId: "msg1" }));
      expect(res.status).toBe(400);
    });
  });

  describe("File Export", () => {
    it("exports a single file correctly", async () => {
      (prisma.message.findFirst as any).mockResolvedValue({
        content: `
        <codemind_artifact type="file" name="test.ts">
        export const x = 1;
        </codemind_artifact>`,
      });

      const res = await exportFile(
        request("http://localhost:3000/api/export/file", {
          messageId: "msg1",
          filename: "test.ts",
        })
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="test.ts"');
      expect(await res.text()).toContain("export const x = 1;");
    });

    it("returns 404 when the named artifact is absent from the message", async () => {
      (prisma.message.findFirst as any).mockResolvedValue({ content: "just prose" });

      const res = await exportFile(
        request("http://localhost:3000/api/export/file", {
          messageId: "msg1",
          filename: "test.ts",
        })
      );
      expect(res.status).toBe(404);
    });
  });
});
