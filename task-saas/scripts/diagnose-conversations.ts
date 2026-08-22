/**
 * Read-only conversation health report. WRITES NOTHING.
 *
 * Two questions, both answered from row counts rather than message text:
 *
 *   1. FRAGMENTATION — how many conversations were split by the dashboard forking
 *      bug, where the client sent no conversationId so the route opened a fresh
 *      conversation for every turn. A forked conversation is titled from the
 *      session's FIRST message (the client array accumulates, so `messages[0]` never
 *      changes) while holding only the LATEST turn. They therefore appear as several
 *      conversations sharing one title, each with a single exchange.
 *
 *   2. CONTEXT EXERCISE — how much of the memory system has actually run. The rolling
 *      summary only fires when turns fall out of the context window, and historical
 *      retrieval only matters once a conversation is longer than the recent window.
 *      A population of two-message conversations means neither has ever been used in
 *      anger, whatever the tests say.
 *
 * PRIVACY: prints titles truncated to TITLE_PREVIEW_CHARS and never prints message
 * bodies. Safe to run against production and paste the output.
 *
 * Usage — supply the database in the shell, never in the file:
 *
 *   PowerShell:  $env:DATABASE_URL = "<connection string>"
 *                npx tsx scripts/diagnose-conversations.ts
 *                Remove-Item Env:\DATABASE_URL
 *
 * Check the "DATABASE" line in the output names the host you intended before trusting
 * the numbers: Prisma falls back to .env when DATABASE_URL is not set in the shell.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/** Titles are shown only as a short prefix; message content is never printed. */
const TITLE_PREVIEW_CHARS = 48;

const prisma = new PrismaClient();

function titlePreview(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length > TITLE_PREVIEW_CHARS ? `${clean.slice(0, TITLE_PREVIEW_CHARS)}…` : clean;
}

/** Host only — never the credential. */
function describeDatabase(): string {
  const raw = process.env.DATABASE_URL ?? "";
  const match = raw.match(/@([^/?]+)/);
  return match ? match[1] : "(DATABASE_URL not set)";
}

async function main(): Promise<void> {
  console.log(`DATABASE            ${describeDatabase()}`);
  console.log("");

  const conversations = await prisma.conversation.findMany({
    select: {
      id: true,
      title: true,
      userId: true,
      summary: true,
      createdAt: true,
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const messageTotal = await prisma.message.count();
  const withSummary = conversations.filter((c) => (c.summary ?? "").trim().length > 0).length;

  // --- Context exercise --------------------------------------------------------
  const buckets = { "1-2": 0, "3-4": 0, "5-8": 0, "9+": 0 };
  for (const c of conversations) {
    const n = c._count.messages;
    if (n <= 2) buckets["1-2"]++;
    else if (n <= 4) buckets["3-4"]++;
    else if (n <= 8) buckets["5-8"]++;
    else buckets["9+"]++;
  }
  const longest = conversations
    .map((c) => c._count.messages)
    .sort((a, b) => b - a)
    .slice(0, 8);

  console.log("CONTEXT EXERCISE");
  console.log(`  conversations        ${conversations.length}`);
  console.log(`  messages             ${messageTotal}`);
  console.log(`  with rolling summary ${withSummary}`);
  console.log(`  length distribution  ${JSON.stringify(buckets)}`);
  console.log(`  longest 8            ${JSON.stringify(longest)}`);
  console.log("");

  // --- Fragmentation -----------------------------------------------------------
  const byTitle = new Map<string, typeof conversations>();
  for (const c of conversations) {
    const key = `${c.userId}::${c.title}`;
    const bucket = byTitle.get(key) ?? [];
    bucket.push(c);
    byTitle.set(key, bucket);
  }

  // Array.from rather than spread: this project's tsconfig target predates
  // downlevelIteration, so spreading a Map iterator is a compile error.
  const groups = Array.from(byTitle.values())
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length);
  const forked = groups.reduce((sum, g) => sum + g.length - 1, 0);

  console.log("FRAGMENTATION (dashboard forking)");
  console.log(`  groups sharing a title ${groups.length}`);
  console.log(`  likely forked          ${forked}`);
  console.log(
    `  share of all convs     ${
      conversations.length > 0 ? ((forked / conversations.length) * 100).toFixed(1) : "0.0"
    }%`
  );
  console.log("");
  console.log("  largest groups (oldest first is the original):");
  for (const group of groups.slice(0, 10)) {
    console.log(`    x${group.length}  "${titlePreview(group[0].title)}"`);
    for (const c of group) {
      console.log(
        `        ${c.id}  messages=${c._count.messages}  created=${c.createdAt.toISOString()}`
      );
    }
  }
}

main()
  .catch((error) => {
    console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
