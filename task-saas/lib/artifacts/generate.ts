import { generateText, type LanguageModelV1 } from "ai";
import { getModel } from "@/lib/ai/gateway";
import { parseArtifactOutput } from "./parse";
import { validateArtifact } from "./validate";
import { verifyArtifact, type VerificationReport } from "./verify";
import { scrubForLog } from "@/lib/ai/failure-classification";
import { getArtifactOutputTokenLimit } from "@/lib/env";
import { ARTIFACT_LIMITS, type ArtifactType, type NormalizedArtifact } from "./types";

/**
 * Artifact generation — the "AI orchestration" stage.
 *
 * Runs as a single non-streaming completion, deliberately separate from the chat
 * stream. Nothing produced here is ever streamed to the browser; only the parsed,
 * validated result leaves this module.
 */

/**
 * Output budget for artifact generation. Kept separate from the chat limit so normal
 * replies stay short, and hard-capped by AI_LIMIT_BOUNDS: raising this indefinitely is
 * not how large projects are handled — an over-large project fails honestly instead.
 *
 * Defined in lib/env.ts with every other limit; re-exported here so existing importers
 * keep their import path.
 */
export { getArtifactOutputTokenLimit };

const COMMON_RULES = `Hard rules:
- Every file must be COMPLETE and runnable. Never write "...", "continue", "rest of the code", "omitted for brevity", or leave a statement, function or bracket unfinished.
- If the whole thing will not fit, produce FEWER files, each complete. Never truncate a file.
- Never include real API keys, tokens, credentials, or a .env file. A .env.example with obvious placeholders is fine.
- Do not wrap file contents in Markdown code fences.
- Output nothing outside the tags described above. No preamble, no explanation, no closing remarks.`;

function instructionsFor(type: ArtifactType): string {
  switch (type) {
    case "zip":
      return `You are generating a downloadable project archive.

Reply with EXACTLY this structure:

<codemind_summary>One or two plain sentences telling the user what you built. No code, no file listing.</codemind_summary>
<codemind_artifact type="zip" name="kebab-case-name.zip">
<file path="package.json">
complete file content
</file>
<file path="src/index.ts">
complete file content
</file>
</codemind_artifact>

- Paths are relative POSIX paths such as "src/app/page.tsx". Never absolute, never containing "..", never using backslashes.
- At most ${ARTIFACT_LIMITS.maxFiles} files, and at most ${Math.floor(ARTIFACT_LIMITS.maxFileBytes / 1024)}KB per file.
- Include everything needed to install and run: manifest, config, source, and a short README.md.

${COMMON_RULES}`;

    case "file":
      return `You are generating a single downloadable source file.

Reply with EXACTLY this structure:

<codemind_summary>One plain sentence telling the user what you created.</codemind_summary>
<codemind_artifact type="file" name="middleware.ts">
complete file content
</codemind_artifact>

- Use the exact filename the user asked for when they named one.
- The artifact body is the raw file content, with no <file> tags around it.

${COMMON_RULES}`;

    case "pdf":
      return `You are generating a downloadable PDF document.

Reply with EXACTLY this structure:

<codemind_summary>One plain sentence telling the user what the document covers.</codemind_summary>
<codemind_artifact type="pdf" name="kebab-case-name.pdf">
# Document Title

Markdown body. Use "#", "##", "###" headings, "- " bullets, and \`\`\` fenced code blocks.
</codemind_artifact>

- Write a complete, self-contained document. Close every code fence you open.

${COMMON_RULES}`;
  }
}

/**
 * Tokens a provider reported for one generation.
 *
 * Null per field means the provider did not report, never zero — the same contract
 * Message.promptTokens carries, kept identical so a value can travel from here to the
 * column without a translation step that could invent a number.
 */
export interface ArtifactUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export type ArtifactGeneration =
  | {
      ok: true;
      artifact: NormalizedArtifact;
      summary: string;
      usage: ArtifactUsage;
      /**
       * Static verification result. Present on success including when it carries
       * warnings — an artifact is only `ok: true` if verification found no ERRORS.
       */
      verification: VerificationReport;
    }
  | {
      ok: false;
      errors: string[];
      /**
       * Present only when verification is what rejected the artifact. Absent for the
       * earlier failures — a generation that never parsed has nothing to verify, and
       * an empty report there would read as "checked and found nothing wrong".
       */
      verification?: VerificationReport;
    };

export interface GenerateArtifactOptions {
  type: ArtifactType;
  /** The user's request, with attachment markup already stripped. */
  userPrompt: string;
  /**
   * Model to generate with. Defaults to the NVIDIA gateway model so existing callers
   * are unaffected; the chat route passes the user's selected model so artifacts are
   * produced by whichever model they chose.
   */
  model?: LanguageModelV1;
  /**
   * Conversation context assembled by ContextManager (summary + retrieved attachment
   * chunks). Passed through so artifact generation sees the same working memory as chat.
   */
  contextPrompt?: string;
  signal?: AbortSignal;
}

/**
 * A count only when the provider actually reported one.
 *
 * Mirrors toTokenCount in app/api/chat/route.ts deliberately rather than importing it:
 * that one lives in a Next route module, which may only export HTTP handlers. The
 * guard matters because @ai-sdk/openai seeds usage as NaN and replaces it only on a
 * usage chunk, and NaN into an Int column is a write error rather than a null.
 */
function toReportedCount(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function defaultSummary(artifact: NormalizedArtifact): string {
  switch (artifact.type) {
    case "zip":
      return `Your project is ready — ${artifact.filename} contains ${artifact.files.length} file${artifact.files.length === 1 ? "" : "s"}.`;
    case "pdf":
      return `Your document ${artifact.filename} is ready.`;
    case "file":
      return `I created ${artifact.filename}.`;
  }
}

export async function generateArtifact(
  options: GenerateArtifactOptions
): Promise<ArtifactGeneration> {
  const { type, userPrompt, contextPrompt, signal } = options;

  const system = contextPrompt
    ? `${instructionsFor(type)}\n\n--- CONVERSATION CONTEXT ---\n${contextPrompt}`
    : instructionsFor(type);

  let output: string;
  let finishReason: string;
  // Captured here because this is the only place holding the provider's response.
  // It used to be discarded, so an artifact turn persisted with no token record at
  // all while the streaming path recorded its own — the same conversation reporting
  // two different truths depending on which branch answered.
  let usage: ArtifactUsage = { promptTokens: null, completionTokens: null };

  try {
    const result = await generateText({
      model: options.model ?? getModel(),
      system,
      prompt: userPrompt,
      maxTokens: getArtifactOutputTokenLimit(),
      // The gateway owns failover across API keys; SDK-level retry would multiply
      // against it and re-run an expensive generation several times over.
      maxRetries: 0,
      abortSignal: signal,
    });
    output = result.text;
    finishReason = result.finishReason;
    usage = {
      promptTokens: toReportedCount(result.usage?.promptTokens),
      completionTokens: toReportedCount(result.usage?.completionTokens),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    // Scrubbed because this string is logged, streamed to the browser, AND persisted
    // as message content. Provider errors are the one place credentials could ever be
    // echoed back, so it must never pass through raw.
    return { ok: false, errors: [`artifact generation failed: ${scrubForLog(message)}`] };
  }

  // Hitting the token ceiling means the tail of the project is missing. Do not salvage.
  if (finishReason === "length") {
    return {
      ok: false,
      errors: [
        "the project was larger than one generation can hold, so the output was cut off",
      ],
    };
  }

  const parsed = parseArtifactOutput(output);
  if (!parsed.artifact || parsed.errors.length > 0) {
    return {
      ok: false,
      errors: parsed.errors.length > 0 ? parsed.errors : ["the model produced no usable artifact"],
    };
  }

  const validation = validateArtifact(parsed.artifact, type);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  /**
   * Static verification, after per-file validation and before anything is persisted.
   *
   * Placed here rather than in the route because this is where the artifact first
   * exists in a trusted form, and because every caller of generateArtifact should get
   * the same guarantee. A caller that could skip verification by construction would
   * eventually be written.
   *
   * Errors are returned in the same `errors` shape as every earlier failure, so the
   * route's existing rejection path handles them without a second branch: the turn is
   * persisted with an honest message naming the first problem, and no Artifact row is
   * written. That is the policy lib/env.ts states for truncated output, applied to a
   * project that is complete file-by-file and incoherent as a whole.
   */
  const verification = verifyArtifact(validation.artifact);
  if (!verification.ok) {
    return {
      ok: false,
      errors: verification.errors.map((finding) => finding.message),
      verification,
    };
  }

  return {
    ok: true,
    artifact: validation.artifact,
    summary: parsed.summary ?? defaultSummary(validation.artifact),
    usage,
    verification,
  };
}
