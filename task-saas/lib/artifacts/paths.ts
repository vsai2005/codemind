import path from "node:path";
import { ARTIFACT_LIMITS } from "./types";

/**
 * Strict path validation for artifact members.
 *
 * Design rule: we REJECT malicious paths, we never "sanitize" them into a different
 * path. Strip-and-continue schemes (e.g. `p.replace(/\.\.\//g, "")`) are bypassable —
 * `"....//"` collapses back into `"../"` after a single pass — so transformation is
 * not used as a security mechanism anywhere in this module.
 *
 * A path is accepted only if it is a plain relative POSIX path whose resolution
 * against a synthetic root lands strictly inside that root.
 */

const ARTIFACT_ROOT = "/__codemind_artifact_root__";

export type PathCheck = { ok: true; value: string } | { ok: false; reason: string };

const fail = (reason: string): PathCheck => ({ ok: false, reason });

/** True if the string contains C0/C1 control characters or a NUL byte. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a file path destined for a ZIP artifact.
 *
 * Rejects: absolute POSIX paths, Windows drive paths, UNC paths, any backslash,
 * `..` traversal in any form, dot-only segments (`.`, `..`, `...`, `....`),
 * empty segments (`a//b`, trailing `/`), NUL bytes, control characters, and
 * percent-encoded separators.
 */
export function validateArtifactPath(raw: unknown): PathCheck {
  if (typeof raw !== "string") return fail("path must be a string");

  const input = raw.trim();
  if (input.length === 0) return fail("path is empty");
  if (input.length > ARTIFACT_LIMITS.maxPathLength) {
    return fail(`path exceeds ${ARTIFACT_LIMITS.maxPathLength} characters`);
  }
  if (hasControlCharacters(input)) return fail("path contains control characters or a null byte");

  // Reject encoded traversal rather than decoding it: artifact paths are literal.
  if (/%(?:2e|2f|5c|00)/i.test(input)) return fail("path contains percent-encoded separators");

  // A single backslash rule covers Windows separators, `..\` traversal and UNC paths.
  if (input.includes("\\")) return fail("path contains a backslash");
  if (/^[a-zA-Z]:/.test(input)) return fail("path contains a drive letter");
  if (input.startsWith("/")) return fail("path is absolute");
  if (input.startsWith("~")) return fail("path starts with a home directory reference");

  const rawSegments = input.split("/");
  if (rawSegments.length > ARTIFACT_LIMITS.maxPathSegments) {
    return fail(`path has more than ${ARTIFACT_LIMITS.maxPathSegments} segments`);
  }

  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment.length === 0) return fail("path contains an empty segment");
    if (segment !== segment.trim()) return fail("path segment has leading or trailing whitespace");

    // A bare "." is a no-op ("./src/index.ts"), so it is dropped rather than rejected.
    if (segment === ".") continue;

    // Rejects "..", and padded variants such as "..." and "...." that defeat
    // strip-once sanitizers.
    if (/^\.{2,}$/.test(segment)) {
      return fail(`path contains a relative segment ("${segment}")`);
    }

    segments.push(segment);
  }

  if (segments.length === 0) return fail("path has no usable segments");

  const candidate = segments.join("/");

  // Containment proof. `candidate` is already free of "."/".."/empty segments, so an
  // honest resolution must reproduce the join exactly; anything else escapes the root.
  const resolved = path.posix.resolve(ARTIFACT_ROOT, candidate);
  const expected = `${ARTIFACT_ROOT}/${candidate}`;
  if (resolved !== expected || !resolved.startsWith(`${ARTIFACT_ROOT}/`)) {
    return fail("path escapes the artifact root");
  }

  return { ok: true, value: candidate };
}

const RESERVED_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Validate an artifact's own download filename (a single path segment).
 *
 * Also guards the `Content-Disposition` header: quotes, semicolons and control
 * characters are rejected, so the filename can be safely interpolated.
 */
export function validateArtifactFilename(
  raw: unknown,
  allowedExtensions?: readonly string[]
): PathCheck {
  if (typeof raw !== "string") return fail("filename must be a string");

  const name = raw.trim();
  if (name.length === 0) return fail("filename is empty");
  if (name.length > ARTIFACT_LIMITS.maxFilenameLength) {
    return fail(`filename exceeds ${ARTIFACT_LIMITS.maxFilenameLength} characters`);
  }
  if (hasControlCharacters(name)) return fail("filename contains control characters");
  if (name.includes("/") || name.includes("\\")) {
    return fail("filename must not contain path separators");
  }
  if (/^\.+$/.test(name)) return fail("filename is a relative segment");
  // Reserved on Windows, and `"` / `;` would break Content-Disposition quoting.
  if (/[<>:"|?*;]/.test(name)) return fail("filename contains reserved characters");
  if (RESERVED_DEVICE_NAMES.test(name)) return fail("filename is a reserved device name");

  if (allowedExtensions && allowedExtensions.length > 0) {
    const lower = name.toLowerCase();
    if (!allowedExtensions.some((ext) => lower.endsWith(ext))) {
      return fail(`filename must end with one of: ${allowedExtensions.join(", ")}`);
    }
  }

  return { ok: true, value: name };
}

/** Quote a validated filename for a Content-Disposition header. */
export function contentDisposition(filename: string): string {
  const check = validateArtifactFilename(filename);
  const safe = check.ok ? check.value : "download";
  return `attachment; filename="${safe}"`;
}
