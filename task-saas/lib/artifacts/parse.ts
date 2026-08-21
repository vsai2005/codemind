import { isArtifactType } from "./types";

/**
 * Parser for the model's artifact wire format.
 *
 * The model is asked to reply with:
 *
 *   <codemind_summary>One sentence for the user.</codemind_summary>
 *   <codemind_artifact type="zip" name="finance-tracker.zip">
 *   <file path="package.json">...</file>
 *   </codemind_artifact>
 *
 * This format exists only between the model and this parser. It is never streamed to
 * the browser and never stored as assistant message content — the parsed result is
 * converted into the normalized structures in ./types.ts and stored separately.
 *
 * Unterminated tags are reported as errors rather than salvaged: a missing
 * </file> or </codemind_artifact> means the generation was cut short, and a
 * truncated project must never be packaged into a downloadable ZIP.
 */

export interface RawArtifactFile {
  path: string;
  content: string;
}

export interface RawArtifact {
  type: string;
  name: string;
  files: RawArtifactFile[];
  /** Body text for `pdf` artifacts. */
  body: string;
}

export interface ArtifactParseResult {
  summary: string | null;
  artifact: RawArtifact | null;
  errors: string[];
}

const SUMMARY_RE = /<codemind_summary>([\s\S]*?)<\/codemind_summary>/i;
const ARTIFACT_OPEN_RE = /<codemind_artifact\s+type="([^"]*)"\s+name="([^"]*)"\s*>/i;
const ARTIFACT_CLOSE = "</codemind_artifact>";
const FILE_RE = /<file\s+path="([^"]*)"\s*>([\s\S]*?)<\/file>/gi;
const FILE_OPEN_RE = /<file\s+path="[^"]*"\s*>/gi;

function countMatches(haystack: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (re.exec(haystack) !== null) count++;
  return count;
}

export function parseArtifactOutput(rawOutput: string): ArtifactParseResult {
  const errors: string[] = [];
  const text = typeof rawOutput === "string" ? rawOutput : "";

  const summaryMatch = SUMMARY_RE.exec(text);
  const summary = summaryMatch ? summaryMatch[1].trim() || null : null;

  const openMatch = ARTIFACT_OPEN_RE.exec(text);
  if (!openMatch) {
    errors.push("the model did not produce an artifact block");
    return { summary, artifact: null, errors };
  }

  const declaredType = openMatch[1].trim().toLowerCase();
  const declaredName = openMatch[2].trim();

  if (!isArtifactType(declaredType)) {
    errors.push(`unsupported artifact type "${declaredType}"`);
    return { summary, artifact: null, errors };
  }

  const bodyStart = openMatch.index + openMatch[0].length;
  const closeIndex = text.toLowerCase().indexOf(ARTIFACT_CLOSE, bodyStart);
  if (closeIndex === -1) {
    errors.push("the artifact block was never closed (generation stopped early)");
    return { summary, artifact: null, errors };
  }

  const body = text.slice(bodyStart, closeIndex);

  if (declaredType === "pdf") {
    return {
      summary,
      artifact: { type: declaredType, name: declaredName, files: [], body: body.trim() },
      errors,
    };
  }

  if (declaredType === "file") {
    // Single-file artifacts carry their content directly in the artifact body.
    return {
      summary,
      artifact: {
        type: declaredType,
        name: declaredName,
        files: [{ path: declaredName, content: stripFenced(body) }],
        body,
      },
      errors,
    };
  }

  // zip
  const files: RawArtifactFile[] = [];
  FILE_RE.lastIndex = 0;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = FILE_RE.exec(body)) !== null) {
    files.push({ path: fileMatch[1].trim(), content: fileMatch[2] });
  }

  // A dangling <file> with no </file> means the model was cut off mid-file.
  const openCount = countMatches(body, FILE_OPEN_RE);
  if (openCount !== files.length) {
    errors.push(
      `${openCount - files.length} file block(s) were never closed (generation stopped early)`
    );
  }

  if (files.length === 0 && errors.length === 0) {
    errors.push("the artifact block contained no files");
  }

  return {
    summary,
    artifact: { type: declaredType, name: declaredName, files, body },
    errors,
  };
}

export interface LocatedArtifact {
  artifact: RawArtifact;
  /** Character span of the whole block in the source string, for excision. */
  start: number;
  end: number;
  /** A legacy self-closing `<codemind_artifact ... />` tag, which carries no body. */
  selfClosing: boolean;
}

const ARTIFACT_OPEN_GLOBAL_RE =
  /<codemind_artifact\s+type="([^"]*)"\s+name="([^"]*)"\s*(\/?)>/gi;

/**
 * Locate every artifact block in stored message content.
 *
 * Used by the legacy backfill (scripts/backfill-artifacts.ts), which needs the exact
 * spans so it can excise markup while preserving the surrounding prose. Unterminated
 * blocks are reported as errors and never returned as usable artifacts.
 */
export function parseAllArtifactBlocks(content: string): {
  blocks: LocatedArtifact[];
  errors: string[];
  /**
   * Offset of the first artifact tag that was never closed, if any. Everything from
   * here to the end of the string is dead markup with no recoverable span, so callers
   * that rewrite content should drop the remainder rather than keep it.
   */
  unterminatedStart: number | null;
} {
  const blocks: LocatedArtifact[] = [];
  const errors: string[] = [];
  let unterminatedStart: number | null = null;
  const lower = content.toLowerCase();

  ARTIFACT_OPEN_GLOBAL_RE.lastIndex = 0;
  let open: RegExpExecArray | null;

  while ((open = ARTIFACT_OPEN_GLOBAL_RE.exec(content)) !== null) {
    const declaredType = open[1].trim().toLowerCase();
    const declaredName = open[2].trim();
    const isSelfClosing = open[3] === "/";
    const start = open.index;

    if (!isArtifactType(declaredType)) {
      errors.push(`unsupported artifact type "${declaredType}"`);
      continue;
    }

    if (isSelfClosing) {
      blocks.push({
        artifact: { type: declaredType, name: declaredName, files: [], body: "" },
        start,
        end: start + open[0].length,
        selfClosing: true,
      });
      continue;
    }

    const bodyStart = start + open[0].length;
    const closeIndex = lower.indexOf(ARTIFACT_CLOSE, bodyStart);
    if (closeIndex === -1) {
      errors.push(`artifact "${declaredName}" was never closed`);
      // Anything after this point is inside the unterminated block.
      unterminatedStart = start;
      break;
    }

    const body = content.slice(bodyStart, closeIndex);
    const end = closeIndex + ARTIFACT_CLOSE.length;

    if (declaredType === "pdf") {
      blocks.push({
        artifact: { type: declaredType, name: declaredName, files: [], body: body.trim() },
        start,
        end,
        selfClosing: false,
      });
    } else if (declaredType === "file") {
      blocks.push({
        artifact: {
          type: declaredType,
          name: declaredName,
          files: [{ path: declaredName, content: stripFenced(body) }],
          body,
        },
        start,
        end,
        selfClosing: false,
      });
    } else {
      const files: RawArtifactFile[] = [];
      FILE_RE.lastIndex = 0;
      let fileMatch: RegExpExecArray | null;
      while ((fileMatch = FILE_RE.exec(body)) !== null) {
        files.push({ path: fileMatch[1].trim(), content: fileMatch[2] });
      }

      const openCount = countMatches(body, FILE_OPEN_RE);
      if (openCount !== files.length) {
        errors.push(
          `artifact "${declaredName}" has ${openCount - files.length} unclosed file block(s)`
        );
        continue;
      }

      blocks.push({
        artifact: { type: declaredType, name: declaredName, files, body },
        start,
        end,
        selfClosing: false,
      });
    }
  }

  return { blocks, errors, unterminatedStart };
}

/**
 * Extract a named artifact block from stored message content.
 *
 * Used only by the legacy /api/export/* routes, which still serve messages written
 * before artifacts moved into their own table. New messages never contain this markup.
 */
export function parseArtifactBlockByName(
  messageContent: string,
  type: "zip" | "file",
  filename: string
): RawArtifact | null {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(
    `<codemind_artifact\\s+type="${type}"\\s+name="${escaped}"\\s*>([\\s\\S]*?)</codemind_artifact>`,
    "i"
  );

  const match = blockRe.exec(messageContent);
  if (!match) return null;

  const body = match[1];

  if (type === "file") {
    return { type, name: filename, files: [{ path: filename, content: stripFenced(body) }], body };
  }

  const files: RawArtifactFile[] = [];
  FILE_RE.lastIndex = 0;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = FILE_RE.exec(body)) !== null) {
    files.push({ path: fileMatch[1].trim(), content: fileMatch[2] });
  }

  return { type, name: filename, files, body };
}

/**
 * Remove a wrapping Markdown code fence if the model added one around a single file.
 */
function stripFenced(content: string): string {
  const trimmed = content.trim();
  const fence = /^```[\w.+-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fence ? fence[1] : content;
}
