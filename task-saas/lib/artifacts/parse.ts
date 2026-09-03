import { isArtifactType, type ArtifactNameSource } from "./types";

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
  /** Whether `name` is the model's own choice or one this parser invented. */
  nameSource: ArtifactNameSource;
}

export interface ArtifactParseResult {
  summary: string | null;
  artifact: RawArtifact | null;
  errors: string[];
}

/**
 * The summary, closed by its own tag OR by the artifact's.
 *
 * THE SAME SLIP, SEEN FROM THE OTHER SIDE. When the model writes `</codemind_artifact>`
 * where `</codemind_summary>` belonged, it destroys two things at once: the artifact's
 * opening tag AND the summary's closing tag. Recovering the archive without this leaves
 * the user holding a file called "project.zip" with no idea what is in it, which is most
 * of the value gone.
 *
 * The alternation is safe because the match is non-greedy: whichever closer appears
 * first wins, so a well-formed summary still ends at its own tag exactly as before.
 */
const SUMMARY_RE = /<codemind_summary>([\s\S]*?)<\/codemind_(?:summary|artifact)>/i;
const ARTIFACT_OPEN_RE = /<codemind_artifact\s+type="([^"]*)"\s+name="([^"]*)"\s*>/i;

/**
 * TOLERATED MALFORMATION: the filename written as a bare token, with `name="` and its
 * closing quote dropped.
 *
 *   <codemind_artifact type="zip" nodejs-typescript-todo-cli.zip>
 *
 * MEASURED, not imagined: three of twelve multi-file cases in the 2026-09-03 GLM 5.3
 * Flash run emitted exactly this and were rejected with "the model did not produce an
 * artifact block" -- a complete, well-formed project thrown away over the attribute
 * syntax around a filename that was sitting right there.
 *
 * WHY THIS ONE IS RECOVERABLE AND THE OTHER IS NOT. Two envelope malformations appeared
 * in that run. Here the filename is PRESENT and only its syntax is wrong, so recovery
 * reads what the model actually chose. In the other, the model closed the summary with
 * `</codemind_artifact>` and never opened the block, so the name does not exist anywhere
 * in the output -- recovering that would mean INVENTING a filename, which is a different
 * decision and deliberately not taken here.
 *
 * The token must contain a dot, so this matches something filename-shaped rather than
 * any stray word. The extracted name then goes through the same filename validation as
 * a quoted one, so recovery cannot smuggle in something a canonical tag could not.
 *
 * THE TWO PATTERNS ARE MUTUALLY EXCLUSIVE, which is a property rather than an ordering
 * rule: `name="x.zip"` contains `=` and `"`, both excluded from the token above, so this
 * pattern cannot match a well-formed tag at any position. Trying the canonical one first
 * is therefore defensive and not load-bearing -- swapping the order survives mutation
 * testing, correctly, because it changes nothing. The order stays because it reads in
 * the direction the logic runs, not because it is holding anything up.
 */
/**
 * TOLERATED MALFORMATION: the filename emitted TWICE, once as a stray token with an
 * orphan quote and once correctly.
 *
 *   <codemind_artifact type="zip" markdown-to-html.zip" name="markdown-to-html.zip">
 *
 * Observed live while re-probing the 2026-09-03 fixes. The real attribute is present and
 * correct, so nothing is invented here -- only the rubbish between `type` and `name` is
 * stepped over. `[^>]*` cannot cross a `>`, so the search stays inside the one tag and
 * cannot reach across into a later element to borrow a name from it.
 */
const ARTIFACT_OPEN_JUNK_BEFORE_NAME_RE =
  /<codemind_artifact\s+type="([^"]*)"[^>]*?\s+name="([^"]*)"\s*>/i;

const ARTIFACT_OPEN_BARE_NAME_RE =
  /<codemind_artifact\s+type="([^"]*)"\s+([^\s"'<>=]*\.[^\s"'<>=]*)\s*>/i;

/**
 * Locate the closing sentinel, case-insensitively, returning offsets into the ORIGINAL
 * string.
 *
 * THE BUG THIS REPLACES, and it shipped because it looks obviously correct:
 *
 *   const closeIndex = text.toLowerCase().indexOf("</codemind_artifact>", bodyStart);
 *   const body = text.slice(bodyStart, closeIndex);
 *
 * The index comes from the lowercased string and the slice is taken from the original.
 * That is only safe while `toLowerCase()` preserves length, and it does not: U+0130
 * (LATIN CAPITAL LETTER I WITH DOT ABOVE) lowercases to TWO code units, `i` + U+0307.
 * Every character after it shifts, so `closeIndex` points one place too far and the
 * slice swallows the leading characters of the sentinel.
 *
 * Measured on real generations: 0 drift in a passing run, +1 in one whose Unicode
 * transliteration map contained `İ`, which put a bare `<` on the end of the file and
 * tripped the truncation checker. That check was right about what it was handed.
 *
 * A REGEX RATHER THAN A HAND-ROLLED CASE-FOLDED SCAN. `exec` reports `index` and the
 * matched text as offsets into the string actually searched, so there is no second
 * string that can disagree with the source — the class of bug is removed rather than
 * worked around. A manual scan would have to re-implement case folding, which is the
 * part that was subtly wrong to begin with.
 *
 * The RegExp is built per call rather than shared: a `g` regex carries mutable
 * `lastIndex`, and a module-level one would make two interleaved parses corrupt each
 * other's position. Allocation is nothing next to that.
 */
function findArtifactClose(text: string, from: number): { start: number; end: number } | null {
  const re = /<\/codemind_artifact\s*>/gi;
  re.lastIndex = from;
  const match = re.exec(text);
  if (!match) return null;
  // `end` from the matched text, not a fixed literal length: the pattern tolerates
  // whitespace before the ">", so the two can legitimately differ.
  return { start: match.index, end: match.index + match[0].length };
}
/**
 * The name given to an archive whose opening tag never appeared.
 *
 * THIS ONE IS SYNTHESIS, and it is the only place in this file that invents anything.
 * When the model closes the summary with `</codemind_artifact>` and never opens the
 * block, the filename does not exist anywhere in the output -- there is nothing to read.
 *
 * The choice is between a generic name and discarding a complete, working project. Two
 * of seventeen organic cases in the 2026-09-03 run were thrown away this way. A file the
 * user can rename is plainly better than no file, and the summary still tells them what
 * it is, so the cost of being wrong here is cosmetic where the cost of refusing is total.
 *
 * Deliberately generic rather than guessed from the summary text: a name derived by
 * skimming prose would sometimes be confidently wrong, which reads worse than something
 * obviously placeholder.
 */
export const RECOVERED_ARCHIVE_NAME = "project.zip";

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

  /**
   * Canonical form first, then the tolerated malformations in decreasing fidelity to
   * what the model actually wrote. The three patterns cannot match the same input --
   * each requires something the others exclude -- so the order documents intent rather
   * than enforcing correctness.
   */
  const canonical = ARTIFACT_OPEN_RE.exec(text);
  const openMatch =
    canonical ??
    ARTIFACT_OPEN_JUNK_BEFORE_NAME_RE.exec(text) ??
    ARTIFACT_OPEN_BARE_NAME_RE.exec(text);

  let declaredType: string;
  let declaredName: string;
  let bodyStart: number;
  let nameSource: ArtifactNameSource;

  if (openMatch) {
    declaredType = openMatch[1].trim().toLowerCase();
    declaredName = openMatch[2].trim();
    bodyStart = openMatch.index + openMatch[0].length;
    // A name read out of a malformed tag is still the model's own choice, and is
    // recorded as such: only the invented one below is untrustworthy.
    nameSource = openMatch === canonical ? "model" : "model-recovered";
  } else {
    /**
     * NO OPENING TAG ANYWHERE, the last and least faithful recovery.
     *
     * The model closed the summary with `</codemind_artifact>` and never opened the
     * block, so both the tag and the filename are missing. What IS present is a run of
     * well-formed <file> blocks and a closing sentinel, which is a whole project.
     *
     * File blocks are what make this recoverable AND what make it a zip: a single-file
     * artifact carries raw content with no <file> tags, and a pdf carries markdown, so
     * their absence of tags means a collapsed one of those has nothing to recover from.
     * A recovered archive still faces validateArtifact against the type the CALLER
     * expected, so guessing zip here cannot smuggle one type in place of another.
     */
    const firstFile = FILE_OPEN_RE.exec(text);
    FILE_OPEN_RE.lastIndex = 0;
    if (!firstFile) {
      errors.push("the model did not produce an artifact block");
      return { summary, artifact: null, errors };
    }
    declaredType = "zip";
    declaredName = RECOVERED_ARCHIVE_NAME;
    bodyStart = firstFile.index;
    nameSource = "synthesized";
  }

  if (!isArtifactType(declaredType)) {
    errors.push(`unsupported artifact type "${declaredType}"`);
    return { summary, artifact: null, errors };
  }
  const close = findArtifactClose(text, bodyStart);
  if (!close) {
    errors.push("the artifact block was never closed (generation stopped early)");
    return { summary, artifact: null, errors };
  }

  const body = text.slice(bodyStart, close.start);

  if (declaredType === "pdf") {
    return {
      summary,
      artifact: { type: declaredType, name: declaredName, files: [], body: body.trim(), nameSource },
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
        nameSource,
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
    artifact: { type: declaredType, name: declaredName, files, body, nameSource },
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
        artifact: { type: declaredType, name: declaredName, files: [], body: "", nameSource: "model" },
        start,
        end: start + open[0].length,
        selfClosing: true,
      });
      continue;
    }

    const bodyStart = start + open[0].length;
    const close = findArtifactClose(content, bodyStart);
    if (!close) {
      errors.push(`artifact "${declaredName}" was never closed`);
      // Anything after this point is inside the unterminated block.
      unterminatedStart = start;
      break;
    }

    const body = content.slice(bodyStart, close.start);
    // Drift here was worse than at the single-artifact site: `end` is where the scan
    // resumes, so a shifted offset mis-sliced the NEXT block as well as this one.
    const end = close.end;

    if (declaredType === "pdf") {
      blocks.push({
        artifact: {
          type: declaredType,
          name: declaredName,
          files: [],
          body: body.trim(),
          nameSource: "model",
        },
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
          nameSource: "model",
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
        artifact: { type: declaredType, name: declaredName, files, body, nameSource: "model" },
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
    return {
      type,
      name: filename,
      files: [{ path: filename, content: stripFenced(body) }],
      body,
      nameSource: "model",
    };
  }

  const files: RawArtifactFile[] = [];
  FILE_RE.lastIndex = 0;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = FILE_RE.exec(body)) !== null) {
    files.push({ path: fileMatch[1].trim(), content: fileMatch[2] });
  }

  return { type, name: filename, files, body, nameSource: "model" };
}

/**
 * Remove a wrapping Markdown code fence if the model added one around a single file.
 */
function stripFenced(content: string): string {
  const trimmed = content.trim();
  const fence = /^```[\w.+-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fence ? fence[1] : content;
}
