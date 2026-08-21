import type { LocatedArtifact } from "./parse";
import type { NormalizedArtifact } from "./types";

/**
 * Pure content transforms for the legacy artifact backfill.
 *
 * Kept separate from scripts/backfill-artifacts.ts (which owns the database and
 * filesystem I/O) so the rewrite rules can be unit tested.
 */

/** Minimum surviving prose for a rewritten message to stand on its own. */
export const MIN_PROSE_LENGTH = 20;

/** A legacy self-closing PDF tag rendered the message text, so it needs enough of it. */
export const MIN_PDF_MARKDOWN_LENGTH = 40;

export const INCOMPLETE_ARTIFACT_NOTE =
  "This reply originally contained a generated project, but it was cut off before it finished and could not be recovered as a download. Ask again to regenerate it.";

function tidy(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove artifact spans from a message and tidy the whitespace they leave behind. */
export function exciseArtifacts(content: string, blocks: LocatedArtifact[]): string {
  let result = content;
  // Right to left so earlier offsets stay valid.
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, block.start) + result.slice(block.end);
  }
  return tidy(result);
}

const FILE_BLOCK_RE = /<file\s+path="[^"]*"\s*>[\s\S]*?<\/file>/gi;
const TRAILING_FILE_RE = /<file\s+path="[^"]*"\s*>[\s\S]*$/i;

/**
 * Strip bare `<file path="...">` blocks that have no `<codemind_artifact>` wrapper.
 *
 * These come from "continue" replies, where an earlier generation was cut off and the
 * model resumed dumping files with no wrapper at all. There is no artifact name or
 * type to recover, so they are removed rather than reconstructed — inventing a project
 * name for an unlabelled, usually truncated dump would be guesswork.
 *
 * Run this only AFTER exciseArtifacts, so files belonging to a real artifact are gone.
 */
export function stripOrphanFileBlocks(content: string): { text: string; count: number } {
  let count = 0;

  let text = content.replace(FILE_BLOCK_RE, () => {
    count++;
    return "";
  });

  // A trailing block whose </file> never arrived.
  if (TRAILING_FILE_RE.test(text)) {
    text = text.replace(TRAILING_FILE_RE, "");
    count++;
  }

  return { text: tidy(text), count };
}

/** One readable line per recovered artifact. */
export function synthesizeContent(artifacts: NormalizedArtifact[]): string {
  const lines = artifacts.map((artifact) => {
    switch (artifact.type) {
      case "zip": {
        const n = artifact.files.length;
        return `Your project is ready — ${artifact.filename} contains ${n} file${n === 1 ? "" : "s"}.`;
      }
      case "pdf":
        return `Your document ${artifact.filename} is ready.`;
      case "file":
        return `I created ${artifact.filename}.`;
    }
  });
  return Array.from(new Set(lines)).join("\n");
}

export interface ReplacementInput {
  /** Message text with all artifact markup removed. */
  prose: string;
  /** Artifacts successfully recovered into the Artifact table. */
  recovered: NormalizedArtifact[];
  /** How many artifacts in this message could not be recovered. */
  unrecoverableCount: number;
}

/**
 * Build the replacement body for a migrated message.
 *
 * Prefers the author's own surviving prose; falls back to a generated one-liner; and
 * appends an honest note when something in the message was beyond recovery. Never
 * returns an empty string — a blank assistant bubble reads as a bug.
 */
export function buildReplacementContent(input: ReplacementInput): string {
  const parts: string[] = [];

  if (input.prose.length >= MIN_PROSE_LENGTH) {
    parts.push(input.prose);
  } else if (input.recovered.length > 0) {
    parts.push(synthesizeContent(input.recovered));
  }

  if (input.unrecoverableCount > 0) {
    parts.push(INCOMPLETE_ARTIFACT_NOTE);
  }

  if (parts.length === 0) {
    parts.push(
      input.recovered.length > 0 ? synthesizeContent(input.recovered) : INCOMPLETE_ARTIFACT_NOTE
    );
  }

  return parts.join("\n\n");
}
