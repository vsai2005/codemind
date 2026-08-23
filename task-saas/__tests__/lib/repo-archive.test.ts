import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { readTarball, type ArchiveEntry } from "@/lib/repo/archive";

/**
 * Long paths in tar archives.
 *
 * The tar header reserves 100 bytes for a filename. GitHub's archives exceed that on
 * genuinely nested files and carry the real name in an extension record instead —
 * PAX (`x`) or GNU LongName (`L`). A reader that ignores those does not throw: it
 * takes the truncated 100-byte name from the following header and produces a file with
 * a mangled path.
 *
 * That path then never matches its RepositoryFile row, so the file's symbols are
 * silently dropped, and the only visible effect is that a nested file mysteriously
 * never appears in an answer. Wrong data wearing the shape of right data — the same
 * failure class as a truncated tree.
 *
 * Real repositories tested during development (is-plain-obj, ky) had maximum path
 * lengths of 26 and 39 characters, so neither exercised this at all. These archives
 * are synthetic precisely so the case is covered deterministically rather than
 * depending on finding a repository nested deeply enough.
 */

const BLOCK = 512;

/** Build one 512-byte tar header. */
function header(name: string, size: number, typeflag: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("000644 \0", 100, "utf8"); // mode
  block.write("0000000 \0", 108, "utf8"); // uid
  block.write("0000000 \0", 116, "utf8"); // gid
  block.write(`${size.toString(8).padStart(11, "0")} `, 124, "utf8");
  block.write(`${Math.floor(Date.now() / 1000).toString(8)} `, 136, "utf8");
  block.write(typeflag, 156, "utf8");
  block.write("ustar\0" + "00", 257, "utf8");

  // Checksum is computed with the checksum field itself read as spaces.
  block.write("        ", 148, "utf8");
  // Indexed rather than for..of: this project's tsconfig target predates
  // downlevelIteration, so iterating a Buffer directly is a compile error.
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i];
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return block;
}

/** Append a header plus its padded data. */
function entry(name: string, content: string, typeflag = "0"): Buffer {
  const data = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
  data.copy(padded);
  return Buffer.concat([header(name, data.length, typeflag), padded]);
}

function gzipTar(parts: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]));
}

function toStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Deliberately split across chunk boundaries: the reader must not assume a
      // header and its data arrive together.
      const mid = Math.floor(buffer.length / 2);
      controller.enqueue(new Uint8Array(buffer.subarray(0, mid)));
      controller.enqueue(new Uint8Array(buffer.subarray(mid)));
      controller.close();
    },
  });
}

async function collect(buffer: Buffer): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await readTarball(toStream(buffer), (e) => entries.push(e));
  return entries;
}

/** GitHub wraps everything in one owner-repo-sha directory, which is stripped. */
const WRAP = "owner-repo-abc1234";

/** 137 characters after the wrapper — comfortably past tar's 100-byte name field. */
const DEEP_PATH =
  "source/features/authentication/providers/credentials/internal/handlers/session-refresh-token-rotation-handler.ts";

describe("tarball reading", () => {
  it("reads ordinary short paths and strips the wrapper directory", async () => {
    const entries = await collect(gzipTar([entry(`${WRAP}/index.js`, "export const a = 1;")]));

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("index.js");
    expect(entries[0].content).toBe("export const a = 1;");
  });

  describe("long paths", () => {
    it("takes the real name from a PAX header, not the truncated one", async () => {
      const full = `${WRAP}/${DEEP_PATH}`;
      expect(full.length).toBeGreaterThan(100);

      // PAX record format: "<length> path=<value>\n", where length counts itself.
      const record = (() => {
        const body = ` path=${full}\n`;
        let length = body.length + 2;
        length = `${length}`.length + body.length;
        return `${length}${body}`;
      })();

      const entries = await collect(
        gzipTar([
          entry("PaxHeaders/0", record, "x"),
          // The following header carries only the truncated name.
          entry(full.slice(0, 100), "export function rotate() {}"),
        ])
      );

      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe(DEEP_PATH);
      expect(entries[0].path.endsWith("session-refresh-token-rotation-handler.ts")).toBe(true);
    });

    it("takes the real name from a GNU LongName entry", async () => {
      const full = `${WRAP}/${DEEP_PATH}`;

      const entries = await collect(
        gzipTar([
          entry("././@LongLink", `${full}\0`, "L"),
          entry(full.slice(0, 100), "export class SessionRefresher {}"),
        ])
      );

      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe(DEEP_PATH);
    });

    it("does not leak a long name onto the entry after it", async () => {
      // A pending long name must be consumed by exactly one entry. Leaking it would
      // give a second, unrelated file the first one's path.
      const full = `${WRAP}/${DEEP_PATH}`;
      const record = (() => {
        const body = ` path=${full}\n`;
        return `${`${body.length + 2}`.length + body.length}${body}`;
      })();

      const entries = await collect(
        gzipTar([
          entry("PaxHeaders/0", record, "x"),
          entry(full.slice(0, 100), "first"),
          entry(`${WRAP}/short.ts`, "second"),
        ])
      );

      expect(entries.map((e) => e.path)).toEqual([DEEP_PATH, "short.ts"]);
    });
  });

  it("skips directories and other non-file entries", async () => {
    const entries = await collect(
      gzipTar([
        entry(`${WRAP}/source/`, "", "5"),
        entry(`${WRAP}/source/a.ts`, "export const a = 1;"),
      ])
    );

    expect(entries.map((e) => e.path)).toEqual(["source/a.ts"]);
  });
});
