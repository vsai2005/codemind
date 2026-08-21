/**
 * One-off backfill: migrate legacy inline artifacts into the Artifact table.
 *
 * Conversations created before artifacts moved into their own table have assistant
 * messages with `<codemind_artifact>` / `<file path="...">` markup baked into their
 * text. This script extracts those into real Artifact rows and rewrites the message
 * to the readable prose that surrounded them, so old history renders as download
 * cards like new history does.
 *
 * Safety model:
 *   - Dry run by default. Nothing is written without --apply.
 *   - A JSON backup of every original message is written BEFORE the first mutation.
 *   - An artifact becomes a download only if it validates AND packages successfully.
 *     Truncated or malformed artifacts are never turned into a download button.
 *   - Without --salvage-incomplete, a message containing any unrecoverable artifact
 *     is left completely untouched — we do not delete content we cannot reproduce.
 *   - Each message is migrated in its own transaction.
 *   - Idempotent: messages that already have Artifact rows are skipped, and a
 *     migrated message no longer contains the marker, so re-runs find nothing.
 *
 * Usage:
 *   npm run backfill:artifacts                                # dry run
 *   npm run backfill:artifacts -- --apply                     # migrate recoverable only
 *   npm run backfill:artifacts -- --salvage-incomplete        # dry run incl. salvage
 *   npm run backfill:artifacts -- --apply --salvage-incomplete
 *   npm run backfill:artifacts -- --apply --limit 10
 *   npm run backfill:artifacts -- --conversation <id>
 *
 * --salvage-incomplete additionally rewrites messages whose artifacts were cut off
 * mid-generation: the dead markup is replaced with an honest note (no download
 * button). The original text is preserved in the backup file.
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { parseAllArtifactBlocks } from "../lib/artifacts/parse";
import { validateArtifact } from "../lib/artifacts/validate";
import { buildArtifactBytes } from "../lib/artifacts/build";
import {
  buildReplacementContent,
  exciseArtifacts,
  stripOrphanFileBlocks,
  MIN_PDF_MARKDOWN_LENGTH,
} from "../lib/artifacts/backfill";
import type { NormalizedArtifact } from "../lib/artifacts/types";

const prisma = new PrismaClient({ log: ["error"] });

interface Args {
  apply: boolean;
  salvage: boolean;
  limit?: number;
  conversationId?: string;
  backupDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    salvage: false,
    backupDir: path.join(process.cwd(), "backups"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--salvage-incomplete") args.salvage = true;
    else if (arg === "--limit") args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === "--conversation") args.conversationId = argv[++i];
    else if (arg === "--backup-dir") args.backupDir = argv[++i];
  }

  if (args.limit !== undefined && (Number.isNaN(args.limit) || args.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  return args;
}

interface CandidateMessage {
  id: string;
  conversationId: string;
  content: string;
}

interface PreparedArtifact {
  artifact: NormalizedArtifact;
  byteSize: number;
}

interface Assessment {
  message: CandidateMessage;
  recovered: PreparedArtifact[];
  unrecoverable: string[];
  newContent: string;
  /** No artifact blocks at all, or nothing actionable. */
  inert: boolean;
}

/** Inspect one message. Performs no writes. */
async function assess(message: CandidateMessage): Promise<Assessment> {
  const { blocks, errors, unterminatedStart } = parseAllArtifactBlocks(message.content);
  const unrecoverable: string[] = [...errors];

  // An unterminated tag has no closing span, so drop everything from it onward —
  // otherwise the dead markup would survive into the rewritten message.
  const base =
    unterminatedStart !== null ? message.content.slice(0, unterminatedStart) : message.content;

  // Orphan <file> blocks are what remains after real artifacts are excised: bare
  // dumps from "continue" replies that never had a wrapper.
  const orphan = stripOrphanFileBlocks(exciseArtifacts(base, blocks));
  const prose = orphan.text;
  if (orphan.count > 0) {
    unrecoverable.push(`${orphan.count} orphan <file> block(s) with no artifact wrapper`);
  }

  if (blocks.length === 0 && unrecoverable.length === 0) {
    return { message, recovered: [], unrecoverable, newContent: message.content, inert: true };
  }
  const recovered: PreparedArtifact[] = [];

  for (const block of blocks) {
    let raw = block.artifact;

    // A legacy self-closing PDF tag meant "render this message as a PDF", so the
    // document body is the surrounding prose.
    if (raw.type === "pdf" && raw.body.trim().length === 0) {
      if (prose.length < MIN_PDF_MARKDOWN_LENGTH) {
        unrecoverable.push(`"${raw.name}": self-closing PDF with no recoverable body text`);
        continue;
      }
      raw = { ...raw, body: prose };
    }

    const validation = validateArtifact(raw, raw.type as NormalizedArtifact["type"]);
    if (!validation.ok) {
      unrecoverable.push(`"${raw.name}": ${validation.errors[0]}`);
      continue;
    }

    // Package now: an artifact that cannot be built must not get a download button.
    try {
      const { body } = await buildArtifactBytes(validation.artifact);
      recovered.push({ artifact: validation.artifact, byteSize: body.byteLength });
    } catch (error) {
      unrecoverable.push(`"${raw.name}": packaging failed (${(error as Error).message})`);
    }
  }

  const newContent = buildReplacementContent({
    prose,
    recovered: recovered.map((r) => r.artifact),
    unrecoverableCount: unrecoverable.length,
  });

  // Final guard: a rewritten message must never still carry artifact markup.
  // If it does, the excision logic missed something — refuse rather than write.
  if (/<codemind_artifact|<file\s+path=/i.test(newContent)) {
    return {
      message,
      recovered: [],
      unrecoverable: ["rewritten content still contains artifact markup; refusing to write"],
      newContent: message.content,
      inert: true,
    };
  }

  return { message, recovered, unrecoverable, newContent, inert: false };
}

async function migrate(assessment: Assessment): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const { artifact, byteSize } of assessment.recovered) {
      await tx.artifact.create({
        data: {
          messageId: assessment.message.id,
          type: artifact.type,
          filename: artifact.filename,
          fileCount: artifact.files.length,
          byteSize,
          payload: {
            type: artifact.type,
            filename: artifact.filename,
            files: artifact.files,
            ...(artifact.markdown ? { markdown: artifact.markdown } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await tx.message.update({
      where: { id: assessment.message.id },
      data: { content: assessment.newContent },
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\nLegacy artifact backfill — ${args.apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Salvage incomplete artifacts: ${args.salvage ? "yes" : "no"}\n`);

  const candidates: CandidateMessage[] = await prisma.message.findMany({
    where: {
      role: "assistant",
      // Idempotency: anything already migrated has Artifact rows attached.
      artifacts: { none: {} },
      OR: [
        { content: { contains: "<codemind_artifact" } },
        // Bare file dumps from "continue" replies, which never had a wrapper.
        { content: { contains: "<file path=" } },
      ],
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    },
    select: { id: true, conversationId: true, content: true },
    orderBy: { createdAt: "asc" },
    ...(args.limit ? { take: args.limit } : {}),
  });

  if (candidates.length === 0) {
    console.log("Nothing to migrate. (Already-migrated messages are skipped by design.)\n");
    return;
  }

  console.log(`Found ${candidates.length} candidate message(s). Validating…\n`);

  const actionable: Assessment[] = [];
  const skipped: Assessment[] = [];

  for (const candidate of candidates) {
    const assessment = await assess(candidate);

    if (assessment.inert) {
      skipped.push(assessment);
      continue;
    }
    // Untouched unless every artifact was recovered, or salvage was requested.
    if (assessment.unrecoverable.length > 0 && !args.salvage) {
      skipped.push(assessment);
      continue;
    }
    actionable.push(assessment);
  }

  for (const item of actionable) {
    const label = item.recovered.length > 0 ? "MIGRATE" : "SALVAGE";
    const summary =
      item.recovered
        .map((a) => `${a.artifact.type}:${a.artifact.filename} (${a.artifact.files.length}f, ${a.byteSize}B)`)
        .join(", ") || `${item.unrecoverable.length} unrecoverable`;

    console.log(`  ${label} ${item.message.id}  ${summary}`);
    console.log(
      `          content ${item.message.content.length} -> ${item.newContent.length} chars`
    );
  }

  for (const item of skipped) {
    const reason = item.inert ? "no parseable artifact blocks" : item.unrecoverable[0];
    console.log(`  SKIP    ${item.message.id}  ${reason}`);
  }

  const recoveredCount = actionable.filter((a) => a.recovered.length > 0).length;
  const salvagedCount = actionable.length - recoveredCount;
  console.log(
    `\nSummary: ${recoveredCount} with recovered artifacts, ${salvagedCount} salvaged (no download), ${skipped.length} untouched.\n`
  );

  if (!args.apply) {
    const hint = skipped.some((s) => !s.inert && s.unrecoverable.length > 0) && !args.salvage;
    console.log("Dry run — no changes written. Re-run with --apply to migrate.");
    if (hint) {
      console.log(
        "Some artifacts were cut off mid-generation and cannot become downloads.\n" +
          "Add --salvage-incomplete to replace their dead markup with an honest note."
      );
    }
    console.log();
    return;
  }
  if (actionable.length === 0) {
    console.log("Nothing to apply.\n");
    return;
  }

  // Back up originals before the first mutation.
  fs.mkdirSync(args.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(args.backupDir, `artifact-backfill-${stamp}.json`);

  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        note: "Original assistant message content prior to legacy artifact backfill.",
        salvageIncomplete: args.salvage,
        messages: actionable.map((a) => ({
          messageId: a.message.id,
          conversationId: a.message.conversationId,
          originalContent: a.message.content,
          newContent: a.newContent,
          recovered: a.recovered.map((r) => r.artifact.filename),
          unrecoverable: a.unrecoverable,
        })),
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Backup written: ${backupPath}\n`);

  let migrated = 0;
  let failed = 0;

  for (const item of actionable) {
    try {
      await migrate(item);
      migrated++;
      console.log(`  ✓ ${item.message.id}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${item.message.id}: ${(error as Error).message}`);
    }
  }

  console.log(`\nDone. Rewrote ${migrated}, failed ${failed}, untouched ${skipped.length}.`);
  console.log(`Restore from ${backupPath} if needed.\n`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("\nBackfill failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
