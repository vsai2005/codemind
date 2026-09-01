/**
 * Measure artifact generation against the verification gate.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 * Earlier versions lived in `__tests__` as scratch files, and vitest ran them: a full
 * suite run made real provider calls, hung for ten minutes, and wrote eleven unplanned
 * rows into the measurement conversation. A file that spends money and mutates the
 * database must not sit where the test runner will find it.
 *
 * WHY BACKOFF EXISTS HERE
 * The previous run lost 22 of 42 turns to Gemini "Too Many Requests". The retry loop had
 * no delay, so three attempts fired inside one second and all three were rejected — the
 * retries were not merely useless, they were guaranteed failures.
 *
 * The gateway is not at fault: it applies RATE_LIMIT_COOLDOWN_MS to a key that returns
 * 429 and backs off exponentially. But that policy assumes a POOL. NVIDIA has six keys
 * to rotate through; Gemini has one, so a single 429 puts the whole provider in cooldown
 * and every immediate retry lands on a key that cannot serve. Waiting is the only thing
 * that helps, and the wait has to outlast the cooldown the gateway itself imposed.
 *
 * RETRY POLICY, and the distinction it turns on: only GENERATION-stage failures are
 * retried. A validation or verification failure is the measurement — re-rolling one
 * would be sampling until the answer is agreeable.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { generateArtifact } from "@/lib/artifacts/generate";
import { buildArtifactBytes } from "@/lib/artifacts/build";
import { attemptFromReport } from "@/lib/artifacts/verify";
import { resolveModel, getDefaultModelId } from "@/lib/ai/models/registry";
import { getArtifactOutputTokenLimit } from "@/lib/env";
import { estimateTokens } from "@/lib/ai/context-manager";
import type { ArtifactType } from "@/lib/artifacts/types";
import { backoffFor, jittered, looksRateLimited } from "./lib/backoff";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Case {
  label: string;
  type: ArtifactType;
  prompt: string;
  /** Lower the output ceiling for this case only, to force truncation deterministically. */
  outputTokenLimit?: number;
}

const CASES: Case[] = [
  { label: "single-debounce", type: "file", prompt: "Write a single TypeScript file implementing a debounce function with types and JSDoc." },
  { label: "single-slugify", type: "file", prompt: "Write one TypeScript file that slugifies a string, handling unicode and repeated separators." },
  { label: "single-retry", type: "file", prompt: "Write one TypeScript file with a retry helper using exponential backoff and a max attempt count." },
  { label: "single-csv", type: "file", prompt: "Write a single JavaScript file that parses CSV text into an array of objects, handling quoted fields." },
  { label: "single-lru", type: "file", prompt: "Write one TypeScript file implementing an LRU cache class with get, set and a size limit." },
  { label: "zip-todo-cli", type: "zip", prompt: "Create a downloadable Node.js TypeScript CLI todo app project, about 6 files, with package.json, tsconfig.json, src/index.ts, src/store.ts, src/types.ts and a README." },
  { label: "zip-express-api", type: "zip", prompt: "Create a downloadable Express REST API project in TypeScript with about 8 files: package.json, tsconfig.json, src/server.ts, src/routes/users.ts, src/routes/health.ts, src/db.ts, src/types.ts, README." },
  { label: "zip-react-counter", type: "zip", prompt: "Create a downloadable React + Vite counter app project with about 7 files including package.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx, src/counter.ts and README." },
  { label: "zip-markdown-tool", type: "zip", prompt: "Create a downloadable Node.js project that converts markdown files to HTML, about 6 files, with package.json, src/index.js, src/parser.js, src/render.js, test/parser.test.js and README." },
  { label: "zip-python-scraper", type: "zip", prompt: "Create a downloadable Python web scraper project with about 6 files: requirements.txt, main.py, scraper/fetch.py, scraper/parse.py, scraper/__init__.py and README." },
  { label: "zip-go-server", type: "zip", prompt: "Create a downloadable Go HTTP server project with about 5 files: go.mod, main.go, handlers/health.go, handlers/echo.go and README." },
  { label: "zip-prisma-api", type: "zip", prompt: "Create a downloadable Node.js TypeScript API project that uses Prisma, about 8 files, including package.json, tsconfig.json, prisma/schema.prisma, src/index.ts, src/db.ts, src/routes.ts and README." },
  { label: "zip-next-app", type: "zip", prompt: "Create a downloadable Next.js app project with about 8 files including package.json, next.config.js, tsconfig.json, app/page.tsx, app/layout.tsx, app/api/hello/route.ts and README." },
  { label: "zip-event-bus", type: "zip", prompt: "Create a downloadable TypeScript event bus library project with about 7 files: package.json, tsconfig.json, src/index.ts, src/bus.ts, src/types.ts, test/bus.test.ts and README." },
  { label: "zip-large-blog", type: "zip", prompt: "Create a downloadable full-stack blog project in TypeScript with about 14 files covering server, routes, models, validation, tests and configuration. Each file must be complete." },
  { label: "zip-large-ecommerce", type: "zip", prompt: "Create a downloadable e-commerce API project in TypeScript with about 15 files covering products, cart, orders, auth middleware, validation, database access, tests and configuration. Each file must be complete." },
  { label: "zip-large-dashboard", type: "zip", prompt: "Create a downloadable React dashboard project with about 14 files: components, hooks, api client, routing, styles, configuration and tests. Each file must be complete." },
  {
    label: "X-unresolved-import", type: "zip",
    prompt: "Create a downloadable TypeScript project containing EXACTLY these three files and no others: package.json, tsconfig.json, and src/index.ts. src/index.ts must begin with the line: import { settings } from './config/settings'; and use settings. Do NOT create src/config/settings.ts — leave it out entirely.",
  },
  {
    label: "X-missing-dependency", type: "zip",
    prompt: "Create a downloadable Node.js TypeScript project with EXACTLY these files: package.json, tsconfig.json, src/index.ts. src/index.ts must import axios and use it. CRITICAL: package.json must contain ONLY the fields name, version, and scripts. It must have NO \"dependencies\" field and NO \"devDependencies\" field at all — omit both keys entirely from the JSON.",
  },
  {
    label: "X-truncation", type: "zip", outputTokenLimit: 300,
    prompt: "Create a downloadable TypeScript project with 12 files: package.json, tsconfig.json and ten fully implemented source modules, each with complete function bodies and documentation comments.",
  },
  {
    label: "X-structural-fence", type: "zip",
    prompt: "Create a downloadable TypeScript project with EXACTLY these files: package.json, src/index.ts, and src/stub.ts. src/index.ts must export a constant. src/stub.ts must contain ONLY a markdown code fence and nothing else: a line with three backticks followed by ts, then a line with three backticks. No code inside it, no other text in that file.",
  },
];

const CONTEXT = [
  "--- CONVERSATION SO FAR ---",
  "User: I'm building a small internal tool for my team and I want the code to be plain and easy to read.",
  "Assistant: Understood — I'll keep dependencies minimal and avoid clever abstractions.",
  "User: Also please include a README in anything you generate.",
  "Assistant: Will do.",
].join("\n");

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  const modelId = arg("model", getDefaultModelId());
  const arms = arg("arms", "A,B").split(",");
  const only = arg("only", "");
  const outDir = arg("out", join(process.cwd(), ".measure", String(Date.now())));
  const maxAttempts = Number(arg("attempts", "4"));

  mkdirSync(outDir, { recursive: true });
  const resolved = resolveModel(modelId);
  const cases = only ? CASES.filter((c) => c.label.includes(only)) : CASES;

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("no user in the database");

  const conversation = await prisma.conversation.create({
    data: { title: `Artifact measurement (${modelId})`, userId: user.id },
    select: { id: true },
  });

  console.log(`model=${modelId} cases=${cases.length} arms=${arms.join(",")} out=${outDir}`);
  console.log(`conversation=${conversation.id}`);

  const results: Record<string, unknown>[] = [];
  let rateLimitWaits = 0;
  let totalWaitMs = 0;

  for (const arm of arms) {
    for (const c of cases) {
      const previousLimit = process.env.AI_ARTIFACT_MAX_OUTPUT_TOKENS;
      if (c.outputTokenLimit) {
        process.env.AI_ARTIFACT_MAX_OUTPUT_TOKENS = String(c.outputTokenLimit);
      }
      const limit = getArtifactOutputTokenLimit();

      let gen: Awaited<ReturnType<typeof generateArtifact>> | null = null;
      let retries = 0;
      let waitedMs = 0;
      const started = Date.now();

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        gen = await generateArtifact({
          type: c.type,
          userPrompt: c.prompt,
          contextPrompt: arm === "B" ? CONTEXT : undefined,
          model: resolved.model,
          headerTimeoutMs: resolved.descriptor.headerTimeoutMs,
        });

        // Only an infrastructure failure is retried. Everything else IS the measurement.
        if (gen.ok || gen.stage !== "generation") break;
        if (attempt === maxAttempts - 1) break;

        const message = gen.errors[0] ?? "";
        const rateLimited = looksRateLimited(message);
        const wait = jittered(backoffFor(message, attempt));
        if (rateLimited) rateLimitWaits++;
        retries++;
        waitedMs += wait;
        totalWaitMs += wait;
        console.log(
          `   retry ${retries} for ${c.label}: ${rateLimited ? "rate limited" : "transport"}, waiting ${Math.round(wait / 1000)}s`
        );
        await sleep(wait);
      }

      if (c.outputTokenLimit) {
        if (previousLimit === undefined) delete process.env.AI_ARTIFACT_MAX_OUTPUT_TOKENS;
        else process.env.AI_ARTIFACT_MAX_OUTPUT_TOKENS = previousLimit;
      }

      const durationMs = Date.now() - started;
      const record = {
        arm,
        label: c.label,
        type: c.type,
        ok: gen!.ok,
        stage: gen!.ok ? "persisted" : gen!.stage,
        coverage: gen!.ok ? gen!.verification.coverage : (gen!.verification?.coverage ?? null),
        errors: gen!.ok ? [] : gen!.errors,
        errorCodes: gen!.ok ? [] : (gen!.verification?.errors.map((e) => e.code) ?? []),
        checks: (gen!.ok ? gen!.verification.checks : (gen!.verification?.checks ?? [])).map(
          (x) => ({ check: x.check, status: x.status })
        ),
        warnings: gen!.ok ? gen!.verification.warnings.map((w) => w.code) : [],
        filename: gen!.ok ? gen!.artifact.filename : null,
        fileCount: gen!.ok ? gen!.artifact.files.length : 0,
        outputTokenLimit: limit,
        retries,
        waitedMs,
        durationMs,
      };
      results.push(record);

      const stem = `${arm}__${c.label}`;
      writeFileSync(join(outDir, `${stem}.json`), JSON.stringify(record, null, 2), "utf-8");

      if (gen!.ok) {
        const { body } = await buildArtifactBytes(gen!.artifact);
        const message = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "assistant",
            content: `[${arm}/${c.label}] ${gen!.summary}`,
            artifactAttempt: {
              ok: true,
              stage: "persisted",
              type: c.type,
              coverage: gen!.verification.coverage,
              warningCount: gen!.verification.warnings.length,
              version: 1,
            } as object,
          },
          select: { id: true },
        });
        await prisma.artifact.create({
          data: {
            messageId: message.id,
            userId: user.id,
            type: gen!.artifact.type,
            filename: gen!.artifact.filename,
            fileCount: gen!.artifact.files.length,
            byteSize: body.byteLength,
            verification: gen!.verification as unknown as object,
            payload: {
              type: gen!.artifact.type,
              filename: gen!.artifact.filename,
              files: gen!.artifact.files,
            } as object,
          },
        });
        writeFileSync(
          join(outDir, `${stem}.files.json`),
          JSON.stringify(gen!.artifact.files, null, 2),
          "utf-8"
        );
      } else {
        const attempt = gen!.verification
          ? attemptFromReport(gen!.verification, c.type)
          : { ok: false, stage: gen!.stage, type: c.type, warningCount: 0, version: 1 as const };
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "assistant",
            content: `[${arm}/${c.label}] ${gen!.errors[0] ?? "failed"}`,
            artifactAttempt: attempt as unknown as object,
          },
        });
      }

      console.log(
        `${arm} ${c.label.padEnd(22)} ok=${String(gen!.ok).padEnd(5)} stage=${record.stage.padEnd(12)} ` +
          `cov=${String(record.coverage).padEnd(9)} retries=${retries} ${Math.round(durationMs / 1000)}s`
      );
    }
  }

  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2), "utf-8");

  const byStage = results.reduce<Record<string, number>>((acc, r) => {
    const stage = String(r.stage);
    acc[stage] = (acc[stage] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nturns=${results.length} ${JSON.stringify(byStage)}`);
  console.log(
    `retries=${results.reduce((s, r) => s + Number(r.retries), 0)} rateLimitWaits=${rateLimitWaits} ` +
      `totalWait=${Math.round(totalWaitMs / 1000)}s`
  );
  console.log(`results written to ${outDir}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
