/**
 * Normalized, INTERNAL artifact representation.
 *
 * The AI model emits a tag-based wire format (see lib/artifacts/parse.ts), which is
 * immediately parsed into the structures below. Everything downstream — validation,
 * packaging, persistence — works on these types only.
 *
 * IMPORTANT: `NormalizedArtifact` (which carries real file contents) must never be
 * serialized to the browser. Only `ArtifactMetadata` crosses the network boundary.
 */

export const ARTIFACT_TYPES = ["zip", "pdf", "file"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

export interface ArtifactFile {
  /** Validated, root-relative POSIX path. Never absolute, never traversing. */
  path: string;
  content: string;
}

/**
 * INTERNAL ONLY — contains full source contents.
 *
 * - `zip`  → one or more files
 * - `file` → exactly one file
 * - `pdf`  → no files; renderable Markdown lives in `markdown`
 */
/**
 * Where an artifact's filename came from.
 *
 * WHY THIS IS RECORDED. The parser recovers from malformed opening tags, and one of
 * those recoveries INVENTS a name because the model never emitted one. Without this
 * field a persisted artifact called "project.zip" is indistinguishable from one the
 * model deliberately named that, so no measurement can separate "the model named this"
 * from "we made it up" after the fact.
 *
 * That is not hypothetical: in the arm B run of 2026-09-03, two turns persisted as
 * "project.zip" with a perfectly good filename sitting in their output, and both
 * reported ok=true with full check coverage. They looked like clean passes in every
 * metric available.
 *
 *   "model"           the canonical tag carried it
 *   "model-recovered" read out of a malformed tag -- still the model's own choice
 *   "synthesized"     no name existed anywhere in the output; this one is ours
 *
 * The middle value exists because collapsing it into either neighbour loses the
 * distinction that matters: a recovered name is as trustworthy as a canonical one, and
 * a synthesized name is not trustworthy at all.
 */
export type ArtifactNameSource =
  | "model"
  | "model-recovered"
  | "synthesized"
  /**
   * Read back from a row written before this field existed. NEVER produced by the
   * parser -- only by reconstructing a legacy payload, where the answer is genuinely
   * unknown. Kept distinct from the three real values so historical rows cannot be
   * silently counted as model-named, which is the exact conflation this field exists
   * to prevent.
   */
  | "unrecorded";

export interface NormalizedArtifact {
  type: ArtifactType;
  filename: string;
  files: ArtifactFile[];
  markdown?: string;
  nameSource: ArtifactNameSource;
}

/** Client-safe artifact descriptor. Deliberately carries no file contents. */
export interface ArtifactMetadata {
  id: string;
  type: ArtifactType;
  filename: string;
  fileCount: number;
  byteSize: number;
}

/**
 * Shape of the AI SDK message annotation used to attach artifacts to an
 * assistant message. Read by components/chat/ChatMessage.tsx.
 */
export interface ArtifactAnnotation {
  codemindArtifacts: ArtifactMetadata[];
}

export function isArtifactAnnotation(value: unknown): value is ArtifactAnnotation {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ArtifactAnnotation).codemindArtifacts)
  );
}

/** Progress events streamed to the UI during artifact generation (transient, never persisted). */
export type ArtifactPhase =
  | "planning"
  | "generating"
  | "validating"
  | "packaging"
  | "ready"
  | "failed";

export interface ArtifactProgress {
  codemindProgress: {
    phase: ArtifactPhase;
    label: string;
  };
}

export const ARTIFACT_LIMITS = {
  /** Maximum number of files in a single ZIP artifact. */
  maxFiles: 60,
  /** Maximum size of any one generated file. */
  maxFileBytes: 512 * 1024,
  /** Maximum total uncompressed size across all files in an artifact. */
  maxTotalBytes: 5 * 1024 * 1024,
  maxPathLength: 400,
  maxPathSegments: 40,
  maxFilenameLength: 120,
} as const;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
