import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Project collection.
 *
 * Ownership is a property of the query, never of the request body: every read is
 * scoped with `userId` from the session and every write sets `userId` from the
 * session. Nothing the client sends can name an owner.
 *
 * The list projection is deliberate — only the fields the sidebar renders, plus a
 * conversation count via Prisma's `_count` (one aggregate in the same query, no N+1).
 * Conversation rows themselves are never included here.
 */

/**
 * Kept in step with the copy in app/api/projects/[id]/route.ts. Next only permits
 * HTTP-method and route-config exports from a route module, so these cannot be
 * shared from here without breaking the build's route typecheck.
 */
const nameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(120, "name must be 120 characters or fewer");

/** Nullable on purpose: `null` clears the description, `undefined` leaves it alone. */
const descriptionSchema = z
  .string()
  .trim()
  .max(2000, "description must be 2000 characters or fewer")
  .nullable();

const createProjectSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
});

/** Flatten Zod issues into a short, non-leaky error string. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Archived projects are hidden from the default listing but never deleted; pass
    // ?archived=1 to see them. Their conversations and artifacts stay fully intact.
    const includeArchived = new URL(request.url).searchParams.get("archived") === "1";

    const projects = await prisma.project.findMany({
      where: {
        userId: session.user.id,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        instructions: true,
        memory: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { conversations: true } },
      },
    });

    return NextResponse.json(projects);
  } catch (error) {
    logger.error("Failed to list projects", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to fetch projects" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Reuses the existing cheap-write bucket rather than adding one; lib/rate-limit.ts
    // is owned elsewhere and its bucket set is fixed.
    const limited = enforceRateLimit("projects", request, userId);
    if (limited) return limited;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsed = createProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatIssues(parsed.error) },
        { status: 400 }
      );
    }

    const project = await prisma.project.create({
      // userId comes from the session only. A `userId` in the body is ignored because
      // it was never read out of the parsed schema.
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        userId,
      },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Wrapped to match GET /api/projects/[id] and PATCH, which both return { project }.
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    logger.error("Failed to create project", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 });
  }
}
