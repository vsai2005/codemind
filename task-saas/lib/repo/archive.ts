import zlib from "node:zlib";

/**
 * Reading a repository's contents in ONE GitHub request.
 *
 * WHY THIS EXISTS
 * Symbols cannot come from the file tree — it returns path, size and blob sha, and
 * nothing about contents. Extracting them means reading bytes, and reading bytes per
 * file costs one API request each: a 500-file repository would spend 10% of the
 * server's hourly budget to index once. That is not viable against a token shared by
 * every user.
 *
 * The tarball endpoint returns the entire repository for ONE request, measured:
 *
 *   sindresorhus/is-plain-obj    4 KB gz →  0.03 MB   rate-limit consumed: 1
 *   sindresorhus/ky            281 KB gz →  0.81 MB   rate-limit consumed: 1
 *
 * So ingestion goes from two requests to three, at any repository size, rather than
 * from two to N.
 *
 * WHY IT STREAMS
 * This runs on a 512 MB instance. Decompressing an archive into a single buffer works
 * for a small repository and falls over on a large one, so the gzip stream is consumed
 * incrementally and each entry is handed to the caller and then dropped. Nothing holds
 * more than one file plus the parser's own window.
 *
 * NO DEPENDENCY
 * gunzip is built into Node. Tar is a simple format — 512-byte headers, data padded to
 * 512 — so the reader below is short. The part that is NOT simple is long paths, which
 * is handled explicitly rather than hoped about; see readTarEntries.
 */

/** Tar's fixed block size. Every header and every data run is a multiple of this. */
const BLOCK = 512;

/**
 * Ceiling on the decompressed archive.
 *
 * The guard that keeps a large repository from exhausting memory before the file-count
 * check can reject it. Deliberately generous relative to real source trees — the
 * measured repositories were 0.03 MB and 0.81 MB — and far below what would threaten
 * a 512 MB instance.
 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Files larger than this are skipped: no source file worth scanning is this big. */
export const MAX_ENTRY_BYTES = 512 * 1024;

export interface ArchiveEntry {
  /** Path relative to the repository root, with the archive's wrapper directory removed. */
  path: string;
  content: string;
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** Tar stores sizes as octal ASCII. */
function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * GitHub wraps everything in one top-level directory named `owner-repo-sha`. Stripping
 * it is what makes archive paths line up with the tree API's paths, which is required
 * for symbols to attach to the right RepositoryFile row.
 */
function stripWrapper(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(slash + 1);
}

/**
 * Parse a tar buffer into entries, calling `onEntry` for each regular file.
 *
 * LONG PATHS ARE HANDLED, NOT ASSUMED AWAY. The tar header reserves 100 bytes for a
 * name, and GitHub's archives exceed that on genuinely nested files. Two extensions
 * carry the real name and BOTH appear in the wild:
 *
 *   typeflag 'L'  GNU LongName — the next entry's name is this entry's DATA
 *   typeflag 'x'  PAX header   — key=value records, the name under `path=`
 *
 * A reader that ignores them takes the truncated 100-byte name from the following
 * header instead. That does not throw; it produces a file with a mangled path that
 * silently never matches its tree row, so its symbols vanish with no error anywhere.
 * Same failure class as a truncated tree: wrong data wearing the shape of right data.
 */
function parseTar(buffer: Buffer, onEntry: (entry: ArchiveEntry) => void): void {
  let offset = 0;
  /** Set by an 'L' or 'x' header, consumed by the entry that follows it. */
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks terminate the archive.
    if (header.every((byte) => byte === 0)) break;

    const rawName = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = readString(header, 156, 1) || "0";
    // Older tars split long names across prefix + name.
    const prefix = readString(header, 345, 155);

    offset += BLOCK;
    const dataStart = offset;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset += padded;

    if (offset > buffer.length) break;

    if (typeflag === "L") {
      // GNU: this entry's data IS the next entry's name.
      pendingLongName = buffer.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0+$/, "");
      continue;
    }

    if (typeflag === "x" || typeflag === "X") {
      // PAX: "<len> path=<value>\n" records. Only `path` matters here.
      const records = buffer.subarray(dataStart, dataStart + size).toString("utf8");
      const match = records.match(/\d+ path=([^\n]+)\n/);
      if (match) pendingLongName = match[1];
      continue;
    }

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    // '0' and '\0' are regular files; everything else (directories, links) is skipped.
    if (typeflag !== "0" && typeflag !== "\0") continue;

    const path = stripWrapper(name);
    if (path.length === 0 || path.endsWith("/")) continue;
    if (size > MAX_ENTRY_BYTES) continue;

    onEntry({ path, content: buffer.subarray(dataStart, dataStart + size).toString("utf8") });
  }
}

export class ArchiveTooLargeError extends Error {
  constructor() {
    super("The repository archive is too large to read.");
    this.name = "ArchiveTooLargeError";
  }
}

/**
 * Decompress a gzipped tar and yield its regular files.
 *
 * The gunzip runs as a stream with a hard output ceiling so a compression bomb, or
 * simply a very large repository, is refused rather than allowed to exhaust the heap.
 */
export async function readTarball(
  body: ReadableStream<Uint8Array>,
  onEntry: (entry: ArchiveEntry) => void
): Promise<void> {
  const gunzip = zlib.createGunzip();
  const chunks: Buffer[] = [];
  let total = 0;

  const done = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES) {
        gunzip.destroy();
        reject(new ArchiveTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => resolve());
    gunzip.on("error", (error) => reject(error));
  });

  const reader = body.getReader();
  try {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (value) gunzip.write(Buffer.from(value));
    }
    gunzip.end();
    await done;
  } finally {
    reader.releaseLock();
  }

  parseTar(Buffer.concat(chunks), onEntry);
}
