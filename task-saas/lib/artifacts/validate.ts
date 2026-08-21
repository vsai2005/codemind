import { validateArtifactFilename, validateArtifactPath } from "./paths";
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

  const assigned = ASSIGNED_SECRET_RE.exec(content);
  if (assigned && !PLACEHOLDER_RE.test(assigned[2])) {
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
 * Remove string literals and comments so brace counting is not thrown off by
 * braces that appear inside strings or comments.
 */
function stripLiteralsAndComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

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

  // An odd number of fences means a Markdown code block was left open.
  const fences = content.split("```").length - 1;
  if (fences % 2 !== 0) return `"${filePath}" has an unclosed code fence`;

  if (CODE_EXTENSIONS.test(filePath)) {
    if (DANGLING_RE.test(lastLine)) {
      return `"${filePath}" ends mid-statement ("${lastLine.slice(0, 40)}")`;
    }

    const stripped = stripLiteralsAndComments(content);
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
