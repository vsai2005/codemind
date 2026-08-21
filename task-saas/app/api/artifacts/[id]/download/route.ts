import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildArtifactBytes } from "@/lib/artifacts/build";
import { contentDisposition } from "@/lib/artifacts/paths";
import { ARTIFACT_TYPES, type NormalizedArtifact } from "@/lib/artifacts/types";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Download a generated artifact.
 *
 * Bytes are rebuilt from the stored normalized payload on each request rather than
 * cached as a blob. Packaging is deterministic and paths are re-validated during the
 * build, so a stored payload can never widen into an unsafe archive.
 */

const payloadSchema = z.object({
  type: z.enum(ARTIFACT_TYPES),
  filename: z.string().min(1),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  markdown: z.string().optional(),
});

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const limited = enforceRateLimit("download", request, userId);
    if (limited) return limited;

    // Ownership is proven by the join, not by anything the client sent.
    const artifact = await prisma.artifact.findFirst({
      where: {
        id: params.id,
        message: { conversation: { userId } },
      },
      select: { id: true, filename: true, payload: true },
    });

    if (!artifact) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const parsed = payloadSchema.safeParse(artifact.payload);
    if (!parsed.success) {
      logger.error("Stored artifact payload is malformed", { artifactId: artifact.id });
      return NextResponse.json({ error: "Artifact is unavailable" }, { status: 500 });
    }

    const normalized: NormalizedArtifact = parsed.data;
    const { body, contentType } = await buildArtifactBytes(normalized);

    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition(normalized.filename),
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error("Artifact download failed", {
      artifactId: params.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to build artifact" }, { status: 500 });
  }
}
