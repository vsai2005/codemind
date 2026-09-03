import { validateArtifactFilename, validateArtifactPath } from "./paths";
import { maskNonCode } from "@/lib/repo/mask-code";
import {
  ARTIFACT_LIMITS,
  utf8Bytes,
  type ArtifactType,
  type NormalizedArtifact,
} from "./types";
import type { RawArtifact } from "./parse";

/**
 * Artifact validation: completeness, path safety, size, and secret containment.
 *
 * A ZIP is only ever built from an artifact that passed every check here. Partial
 * model output is rejected outright rather than packaged — a download button that
 * yields a half-written project is worse than an honest failure.
 */

export type ArtifactValidation =
  | { ok: true; artifact: NormalizedArtifact }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Secret containment
// ---------------------------------------------------------------------------

/** Live NVIDIA NIM key format. Never allowed to leave the server in any form. */
const NVIDIA_KEY_RE = /\bnvapi-[A-Za-z0-9_-]{20,}\b/;

/** Env files that hold real values (as opposed to `.env.example`, which holds placeholders). */
const REAL_ENV_FILE_RE = /(^|\/)\.env(\.(local|production|development|prod|dev))?$/i;

/**
 * `NAME=<value>` where the value looks substantive rather than an obvious placeholder.
 * Lets a scaffold ship `DATABASE_URL=` or `AUTH_SECRET="your-secret-here"` while still
 * blocking a pasted real credential.
 */
const ASSIGNED_SECRET_RE =
  /\b(NVIDIA_API_KEY(?:_\d)?|AUTH_SECRET|AUTH_GOOGLE_SECRET|DATABASE_URL)\s*[:=]\s*["']?([^\s"'\n]{16,})/i;

const PLACEHOLDER_RE =
  /^(?:your|my|the|placeholder|example|changeme|change-me|xxx+|\.\.\.|<|\{\{|sk-xxx|generate|replace|todo|insert|add-)/i;

/**
 * A value that ANNOUNCES itself as fake by its content rather than its first word.
 *
 * PLACEHOLDER_RE alone reads only the prefix, so it accepted `your-secret-here` and
 * rejected `postgresql://user:password@localhost:5432/mydb` -- the connection string
 * Prisma's own documentation puts in `.env.example`. A real generated project was
 * refused for shipping the canonical example.
 *
 * Two shapes, both unambiguous:
 *   1. a credential pair whose password IS the word "password" (or passwd/secret/
 *      changeme). Nobody's live database is reached with `user:password@`.
 *   2. a loopback or documentation host. A URL pointing at localhost cannot leak
 *      anyone's credentials because it does not address anyone's machine.
 *
 * Deliberately narrow. `postgresql://admin:Xk9mQ2@prod.example-corp.io/db` matches
 * neither and is still blocked, which is the case this check exists for.
 */
const PLACEHOLDER_VALUE_RE =
  /:(?:password|passwd|pass|secret|changeme|yourpassword)@|(?:^|[/@])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|example\.com)(?::|\/|$)/i;

/** A line commented out with `#` or `//`. It assigns nothing. */
const COMMENT_LINE_RE = /^\s*(?:#|\/\/)/;

/**
 * Returns a human-readable reason when content must not be exported, else null.
 * Shared by artifact packaging and the legacy /api/export routes.
 */
export function findSecretLeak(filePath: string, content: string): string | null {
  if (REAL_ENV_FILE_RE.test(filePath)) {
    return `"${filePath}" is an environment file and cannot be exported`;
  }

  if (NVIDIA_KEY_RE.test(content)) {
    return `"${filePath}" contains what looks like a live API key`;
  }

  /**
   * Line by line, and COMMENTED LINES ARE SKIPPED.
   *
   * Scanning the whole blob matched `# DATABASE_URL=mongodb://localhost:27017/blog`
   * as an assignment, because the pattern is unanchored and a `#` two characters to
   * its left means nothing to it. That rejected a project whose author had done the
   * careful thing and commented the line out.
   */
  for (const line of content.split(/\r?\n/)) {
    if (COMMENT_LINE_RE.test(line)) continue;

    const assigned = ASSIGNED_SECRET_RE.exec(line);
    if (!assigned) continue;
    if (PLACEHOLDER_RE.test(assigned[2]) || PLACEHOLDER_VALUE_RE.test(assigned[2])) continue;

    return `"${filePath}" assigns a real value to ${assigned[1]}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Truncation detection
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS =
  /\.(tsx?|jsx?|mjs|cjs|json|java|kt|cs|go|rs|c|cc|cpp|h|hpp|php|swift|css|scss|prisma)$/i;

const CONTINUATION_RE =
  /^(?:continue|continued|\.\.\.|…|\[?(?:rest|remaining|the rest|and so on|etc\.?|omitted|truncated|more)\b)/i;

/** Trailing token that cannot legally end a source file. */
const DANGLING_RE = /(?:[=+\-*/%&|^,:<([{]|=>|&&|\|\||\?\.|\bconst\b|\blet\b|\breturn\b)$/;

/**
 * Endings that LOOK dangling to the rule above but legally terminate a file.
 *
 * A closing block-comment marker is the whole list, and it is not a corner case:
 * the character class in DANGLING_RE contains both the star and the slash, so every
 * file whose last line closes a block comment matched it.
 *
 * MEASURED, not hypothetical. Three of three single-file artifacts that reached
 * validation in a 42-generation run were rejected this way, each a complete file
 * ending in a trailing JSDoc or a commented-out usage example. A valid artifact
 * refused outright is worse than one that slips through, so the exclusion is checked
 * alongside the dangling rule rather than left to a caller.
 *
 * NOT widened beyond this. A file truncated part-way through a block comment does
 * not end in that marker at all, because the comment is left unterminated, so this
 * cannot hide that case. It was already invisible to this rule and remains so.
 */
const LEGAL_TRAILING_RE = /\*\/$/;


/**
 * Detect a file whose content stops mid-way. Returns a reason or null.
 *
 * Only *unclosed* bracket imbalance counts as evidence: a truncated file always has
 * more openers than closers, whereas the reverse usually means the naive scan was
 * confused. This asymmetry keeps false rejections of valid files low.
 */
export function findTruncation(filePath: string, content: string): string | null {
  if (content.trim().length === 0) return `"${filePath}" is empty`;

  const lines = content.split("\n");
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastLine = lines[i].trim();
      break;
    }
  }

  if (CONTINUATION_RE.test(lastLine)) {
    return `"${filePath}" ends with a continuation marker ("${lastLine.slice(0, 40)}")`;
  }

  /**
   * An odd number of fence DELIMITERS means a Markdown code block was left open.
   *
   * COUNTED AT LINE START, which is what Markdown actually requires. Counting every
   * occurrence anywhere in the content -- `content.split("```").length - 1` -- also
   * counts prose, and prose about Markdown is exactly what a README contains.
   *
   * MEASURED: zip-markdown-tool was rejected in the 2026-09-03 GLM 5.3 Flash run for an
   * "unclosed code fence" it did not have. Its README held three properly paired fences
   * and one sentence mentioning them:
   *
   *   - Fenced code blocks (```) with language labels
   *
   * Seven occurrences, an odd number, and a complete working project was thrown away
   * over a line of documentation. A false rejection is expensive and silent: the user is
   * told their project is malformed when it is not.
   *
   * Up to three leading spaces stay a fence per CommonMark; four or more make it an
   * indented code block, where backticks are literal text rather than a delimiter.
   */
  const fences = content
    .split("\n")
    .filter((line) => /^ {0,3}```/.test(line)).length;
  if (fences % 2 !== 0) return `"${filePath}" has an unclosed code fence`;

  if (CODE_EXTENSIONS.test(filePath)) {
    if (DANGLING_RE.test(lastLine) && !LEGAL_TRAILING_RE.test(lastLine)) {
      return `"${filePath}" ends mid-statement ("${lastLine.slice(0, 40)}")`;
    }

    /**
     * MASKED WITH THE REPO SCANNER'S MASKER, not a local one.
     *
     * The local stripper had no notion of a regex literal, so `.replace(/"/g, "&quot;")`
     * opened a string at the quote INSIDE the regex that never closed, swallowing the
     * rest of the file along with its final brace. Measured on the 42-case run: two
     * complete, balanced files rejected as having one unclosed brace, in both arms.
     *
     * mask-code.ts already had this right and says why in its own comment — a regex may
     * contain quotes and comment markers, and treating it as code lets those open a
     * bogus string. Keeping a second, weaker implementation here is what let the two
     * disagree; there is now one.
     */
    const stripped = maskNonCode(content);
    const pairs: Array<[string, string, string]> = [
      ["{", "}", "brace"],
      ["[", "]", "bracket"],
      ["(", ")", "parenthesis"],
    ];
    for (const [open, close, label] of pairs) {
      const openCount = stripped.split(open).length - 1;
      const closeCount = stripped.split(close).length - 1;
      if (openCount > closeCount) {
        return `"${filePath}" has ${openCount - closeCount} unclosed ${label}(s)`;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Full artifact validation
// ---------------------------------------------------------------------------

const EXTENSION_FOR_TYPE: Record<ArtifactType, readonly string[] | undefined> = {
  zip: [".zip"],
  pdf: [".pdf"],
  file: undefined,
};

/**
 * Validate a parsed artifact and normalize it. `expectedType` is the server-side
 * intent; the model is not trusted to change it.
 */
export function validateArtifact(
  raw: RawArtifact,
  expectedType: ArtifactType
): ArtifactValidation {
  const errors: string[] = [];

  if (raw.type !== expectedType) {
    errors.push(`expected a ${expectedType} artifact but the model produced ${raw.type}`);
  }

  const nameCheck = validateArtifactFilename(raw.name, EXTENSION_FOR_TYPE[expectedType]);
  if (!nameCheck.ok) {
    errors.push(`invalid artifact filename: ${nameCheck.reason}`);
  }
  if (expectedType === "file" && nameCheck.ok && /\.(zip|pdf)$/i.test(nameCheck.value)) {
    errors.push("a single-file artifact cannot use a .zip or .pdf filename");
  }

  if (errors.length > 0) return { ok: false, errors };
  const filename = nameCheck.ok ? nameCheck.value : "";

  // --- PDF ---------------------------------------------------------------
  if (expectedType === "pdf") {
    const markdown = raw.body.trim();
    if (markdown.length < 40) {
      errors.push("the generated document was too short to be a complete PDF");
    } else {
      const truncated = findTruncation(filename, markdown);
      if (truncated) errors.push(truncated);
    }
    const leak = findSecretLeak(filename, markdown);
    if (leak) errors.push(leak);
    if (utf8Bytes(markdown) > ARTIFACT_LIMITS.maxTotalBytes) {
      errors.push("the generated document exceeds the size limit");
    }

    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, artifact: { type: "pdf", filename, files: [], markdown } };
  }

  // --- ZIP / FILE --------------------------------------------------------
  if (raw.files.length === 0) {
    return { ok: false, errors: ["no files were generated"] };
  }
  if (expectedType === "file" && raw.files.length !== 1) {
    return {
      ok: false,
      errors: [`expected exactly one file but received ${raw.files.length}`],
    };
  }
  if (raw.files.length > ARTIFACT_LIMITS.maxFiles) {
    return {
      ok: false,
      errors: [`the project has ${raw.files.length} files, above the ${ARTIFACT_LIMITS.maxFiles} file limit`],
    };
  }

  const seen = new Set<string>();
  const files: NormalizedArtifact["files"] = [];
  let totalBytes = 0;

  for (const file of raw.files) {
    const pathCheck = validateArtifactPath(file.path);
    if (!pathCheck.ok) {
      errors.push(`rejected path "${String(file.path).slice(0, 80)}": ${pathCheck.reason}`);
      continue;
    }
    const safePath = pathCheck.value;

    const dedupeKey = safePath.toLowerCase();
    if (seen.has(dedupeKey)) {
      errors.push(`duplicate path "${safePath}"`);
      continue;
    }
    seen.add(dedupeKey);

    const content = file.content.replace(/^\n/, "").replace(/\s+$/, "");

    const truncated = findTruncation(safePath, content);
    if (truncated) {
      errors.push(truncated);
      continue;
    }

    const leak = findSecretLeak(safePath, content);
    if (leak) {
      errors.push(leak);
      continue;
    }

    const bytes = utf8Bytes(content);
    if (bytes > ARTIFACT_LIMITS.maxFileBytes) {
      errors.push(`"${safePath}" exceeds the ${ARTIFACT_LIMITS.maxFileBytes / 1024}KB per-file limit`);
      continue;
    }

    totalBytes += bytes;
    files.push({ path: safePath, content });
  }

  if (totalBytes > ARTIFACT_LIMITS.maxTotalBytes) {
    errors.push(`the project exceeds the ${ARTIFACT_LIMITS.maxTotalBytes / (1024 * 1024)}MB total size limit`);
  }
  if (files.length === 0) {
    errors.push("no valid files remained after validation");
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, artifact: { type: expectedType, filename, files } };
}
