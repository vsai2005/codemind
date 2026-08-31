import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enforceBodyLimit } from "@/lib/http/body-limit";
import { parseRepoUrl } from "@/lib/repo/github";
import { ingestRepository } from "@/lib/repo/ingest";
import { describeCoverage } from "@/lib/repo/structure";
import { DERIVATION_VERSION } from "@/lib/repo/derivation-version";

/**
 * Attach a public GitHub repository to a project and index it.
 *
 * The index is a file list stored in Postgres; contents are fetched per question. See
 * lib/repo/ingest.ts for why nothing is cloned and lib/repo/github.ts for the call
 * budget that shapes it.
 *
 * Errors use the same `{ error }` shape as the chat route, because the client banner
 * added for failed messages parses exactly that and will render these too.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Ahead of any parsing: this bucket guards a GitHub budget shared by every user,
    // so a caller must not be able to spend it by sending malformed requests either.
    const limited = enforceRateLimit("repositoryIngest", req, userId);
    if (limited) return limited;

    const oversized = enforceBodyLimit(req, "chat");
    if (oversized) return oversized;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const payload = body as { url?: unknown; projectId?: unknown };
    if (typeof payload.url !== "string" || typeof payload.projectId !== "string") {
      return NextResponse.json(
        { error: "A repository url and a projectId are required." },
        { status: 400 }
      );
    }

    const ref = parseRepoUrl(payload.url);
    if (!ref) {
      return NextResponse.json(
        {
          error:
            "That does not look like a public GitHub repository URL. Use the form https://github.com/owner/repository.",
        },
        { status: 400 }
      );
    }

    // Ownership from the session, never the body — the same rule the chat route uses
    // before honouring a projectId.
    const project = await prisma.project.findFirst({
      where: { id: payload.projectId, userId },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const result = await ingestRepository(ref);
    if (!result.ok) {
      // A 422 rather than a 500: the request was well-formed and understood, and the
      // repository is what could not be indexed. The message says which.
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    await prisma.project.updateMany({
      where: { id: project.id, userId },
      data: { repositoryId: result.repositoryId },
    });

    logger.info("Attached a repository to a project", {
      projectId: project.id,
      owner: ref.owner,
      name: ref.name,
      files: result.fileCount,
      reused: result.reused,
    });

    /**
     * Read back to report whether an entry point was detected.
     *
     * One query on the attach path, which happens once per repository rather than once
     * per message. The alternative was having ingestion carry the count out in its
     * result, which would have meant changing ingest.ts — and the number is already
     * stored, so re-reading it keeps a single source rather than adding a second.
     */
    const stored = await prisma.repository.findUnique({
      where: { id: result.repositoryId },
      select: { structure: true, derivationVersion: true },
    });
    const storedVersion = stored?.derivationVersion ?? null;
    const storedStructure = stored?.structure as { entryPoints?: unknown } | null;
    const entryPointCount = Array.isArray(storedStructure?.entryPoints)
      ? storedStructure.entryPoints.length
      : undefined;

    return NextResponse.json({
      repositoryId: result.repositoryId,
      owner: ref.owner,
      name: ref.name,
      fileCount: result.fileCount,
      /** True when an existing snapshot for the same commit was reused. */
      reused: result.reused,
      /**
       * What the user actually got, in counts rather than adjectives.
       *
       * Symbol extraction covers JavaScript and TypeScript, so a Python or Go
       * repository indexes to `ready` with no symbols and answers from paths alone —
       * usable, weaker, and until now indistinguishable from a full index. `coverage`
       * carries the numbers; `coverageNote` is the sentence, built in one place so the
       * API and the UI cannot describe the same index differently.
       *
       * Null when there is nothing worth saying, which is the fully covered case. A
       * message that always appears is one nobody reads.
       */
      coverage: result.coverage ?? null,
      // The detected list lives in the same structure blob the coverage does, so the
      // note can report "no entry point" without ingestion storing a second copy.
      coverageNote: describeCoverage(result.coverage, {
        entryPointCount,
        derivationVersion: storedVersion,
        currentDerivationVersion: DERIVATION_VERSION,
      }),
    });
  } catch (error) {
    logger.error("Repository ingestion failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Could not index that repository. Try again shortly." },
      { status: 500 }
    );
  }
}
