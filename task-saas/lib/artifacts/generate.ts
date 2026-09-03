import { generateText, type LanguageModelV1 } from "ai";
import { getModel } from "@/lib/ai/gateway";
import { parseArtifactOutput } from "./parse";
import { validateArtifact } from "./validate";
import { verifyArtifact, type ArtifactStage, type VerificationReport } from "./verify";
import { scrubForLog } from "@/lib/ai/failure-classification";
import { getArtifactOutputTokenLimit } from "@/lib/env";
import { artifactOutputTokensFor } from "@/lib/ai/models/registry";
import { HEADER_TIMEOUT_HEADER } from "@/lib/ai/fetch-timeout";
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
<codemind_artifact type="file" name="descriptive-name.ext">
complete file content
</codemind_artifact>

- Use the exact filename the user asked for when they named one.
- When they did not name one, DERIVE the filename from what the file contains: a debounce helper is "debounce.ts", a CSV parser is "csv-parser.js". Use the extension of the language you wrote.
- "descriptive-name.ext" above is a placeholder showing the attribute's shape. Never emit it, and never reuse a filename from these instructions.
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

- Name the file after what the document is ABOUT: a retry-logic write-up is
  "retry-logic.pdf", an architecture overview is "architecture-overview.pdf".
- "kebab-case-name.pdf" above is a placeholder showing the attribute's shape. Never emit
  it, and never reuse a filename from these instructions.
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
      /** Wall time inside the provider call. See `generationMs` on the failure arm. */
      generationMs: number;
      /** The model's response text, exactly as it arrived. See the failure arm. */
      rawOutput: string;
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
       * Wall time inside the provider call, in ms — the generateText await ALONE, not
       * the surrounding request.
       *
       * WHY THE NARROW SPAN. Durations for the 30 artifacts already in the database had
       * to be reconstructed from consecutive message timestamps, which bundles parsing,
       * validation, verification, the zip build and two DB writes into the number and
       * therefore overstates generation. That reconstruction is what the 180s
       * non-streaming deadline was sized against, so the estimate feeding a deadline
       * was measuring the wrong thing.
       *
       * Recorded on FAILURES too, and that is where it earns most: a 1s failure is a
       * rejected request, a 170s failure is a deadline, and the error strings for the
       * two can be identical.
       */
      generationMs: number;
      /**
       * The model's response text, EXACTLY as it arrived — unparsed, unscrubbed,
       * untrimmed.
       *
       * WHY A REJECTED GENERATION MUST KEEP ITS BYTES. Twice now the most informative
       * result available was thrown away at the moment it was produced: the
       * middleware.ts naming defect and a validation rejection reading
       * `"slugify.ts" ends mid-statement ("<")`. In both cases the question — is the
       * checker right? — is answerable only from the source, and the source was gone
       * because nothing downstream of a rejection persisted it.
       *
       * Absent when the provider call itself failed, because then there is no output
       * to keep. Present for every rejection AFTER the model answered.
       */
      rawOutput?: string;
      /**
       * Which stage rejected it. Always set, because a failure that cannot say where it
       * happened is not measurable — and the responses differ: rising truncation means
       * the output budget is wrong, rising verification means the prompt is.
       */
      stage: ArtifactStage;
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
  /**
   * Header-phase budget for a model measured to be slow to first byte, in ms.
   *
   * The streaming chat path already sends this, but the artifact path returned before
   * reaching that code and generateText was called with the 60s default. Kimi K3 takes
   * ~175s to its first byte, so artifact generation with it could never succeed —
   * failing identically whether the provider was healthy or not. Chat worked; downloads
   * could not.
   *
   * Optional because most models do not need it, and absent means "use the deployment
   * default" rather than "no timeout".
   */
  headerTimeoutMs?: number;
  /**
   * The selected model's DECLARED output ceiling, from its registry descriptor.
   *
   * Passed in rather than resolved here because `model` above arrives as an opaque
   * `LanguageModelV1` with no route back to the descriptor it came from. Re-resolving
   * by id inside this function would mean looking up a model that might not be the one
   * actually being called — a limit and a model that disagree is worse than no clamp.
   * Both real callers already hold a `ResolvedModel`, so the number is free to them.
   *
   * Absent means "unknown ceiling": the env budget applies alone, as it always did.
   */
  modelMaxOutputTokens?: number;
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
  const { type, userPrompt, contextPrompt, signal, headerTimeoutMs, modelMaxOutputTokens } =
    options;

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

  // The clock brackets the provider call and NOTHING else: not prompt assembly above,
  // not parsing, validation, verification or persistence below. A span that includes
  // those is what made the reconstructed estimates overstate generation.
  const startedAt = Date.now();
  let generationMs = 0;

  try {
    const result = await generateText({
      model: options.model ?? getModel(),
      system,
      prompt: userPrompt,
      maxTokens: artifactOutputTokensFor(modelMaxOutputTokens),
      // The gateway owns failover across API keys; SDK-level retry would multiply
      // against it and re-run an expensive generation several times over.
      maxRetries: 0,
      abortSignal: signal,
      // Consumed and stripped by fetch-timeout.ts, so no provider ever sees it. Spread
      // conditionally: sending the header with no value would be read as a malformed
      // override rather than as an absent one.
      ...(headerTimeoutMs
        ? { headers: { [HEADER_TIMEOUT_HEADER]: String(headerTimeoutMs) } }
        : {}),
    });
    // Stopped before the result is even unpacked, so no post-processing leaks in.
    generationMs = Date.now() - startedAt;
    output = result.text;
    finishReason = result.finishReason;
    usage = {
      promptTokens: toReportedCount(result.usage?.promptTokens),
      completionTokens: toReportedCount(result.usage?.completionTokens),
    };
  } catch (error) {
    // Stopped FIRST, before any error handling: a failure's duration is the whole point
    // of recording it on this path — it is what separates a fast rejection from a
    // deadline, which can carry an identical message.
    generationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : "unknown error";
    // Scrubbed because this string is logged, streamed to the browser, AND persisted
    // as message content. Provider errors are the one place credentials could ever be
    // echoed back, so it must never pass through raw.
    return {
      ok: false,
      stage: "generation",
      generationMs,
      errors: [`artifact generation failed: ${scrubForLog(message)}`],
    };
  }

  // Hitting the token ceiling means the tail of the project is missing. Do not salvage.
  if (finishReason === "length") {
    return {
      ok: false,
      stage: "truncation",
      generationMs,
      rawOutput: output,
      errors: [
        "the project was larger than one generation can hold, so the output was cut off",
      ],
    };
  }

  const parsed = parseArtifactOutput(output);
  if (!parsed.artifact || parsed.errors.length > 0) {
    return {
      ok: false,
      stage: "parse",
      generationMs,
      rawOutput: output,
      errors: parsed.errors.length > 0 ? parsed.errors : ["the model produced no usable artifact"],
    };
  }

  const validation = validateArtifact(parsed.artifact, type);
  if (!validation.ok) return {
      ok: false,
      stage: "validation",
      generationMs,
      rawOutput: output,
      errors: validation.errors,
    };

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
      stage: "verification",
      generationMs,
      rawOutput: output,
      errors: verification.errors.map((finding) => finding.message),
      verification,
    };
  }

  return {
    ok: true,
    generationMs,
    rawOutput: output,
    artifact: validation.artifact,
    summary: parsed.summary ?? defaultSummary(validation.artifact),
    usage,
    verification,
  };
}
