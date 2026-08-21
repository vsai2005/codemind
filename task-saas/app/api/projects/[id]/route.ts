import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
// Prisma is used as a value here (Prisma.DbNull), not only as a type.
import { Prisma } from "@prisma/client";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Project detail.
 *
 * Every handler scopes the row by `{ id, userId }` in the query itself — there is no
 * fetch-then-compare anywhere in this file, and writes go through `updateMany`/
 * `deleteMany` so the filter is what the database enforces.
 *
 * Another user's project id returns 404, not 403: a 403 would confirm the id exists.
 */

/** Kept in step with the copy in app/api/projects/route.ts — see the note there. */
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

/** Standing instructions applied to every conversation in the project. */
const instructionsSchema = z
  .string()
  .trim()
  .max(20000, "instructions must be 20000 characters or fewer")
  .nullable();

/** Durable, user-editable project knowledge. Shape is validated, content is not. */
const memorySchema = z
  .array(
    z.object({
      title: z.string().trim().min(1).max(120),
      items: z.array(z.string().trim().min(1).max(500)).max(50),
    })
  )
  .max(20)
  .nullable();

const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
    memory: memorySchema.optional(),
    /** true archives, false restores. Archiving never deletes anything. */
    archived: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.instructions !== undefined ||
      data.memory !== undefined ||
      data.archived !== undefined,
    { message: "provide at least one field to update" }
  );

const projectSelect = {
  id: true,
  name: true,
  description: true,
  instructions: true,
  memory: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { conversations: true } },
};

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const project = await prisma.project.findFirst({
      where: { id: params.id, userId: session.user.id },
      select: projectSelect,
    });

    if (!project) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    logger.error("Failed to fetch project", {
      projectId: params.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to fetch project" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const limited = enforceRateLimit("projects", request, userId);
    if (limited) return limited;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const parsed = updateProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatIssues(parsed.error) },
        { status: 400 }
      );
    }

    // Only the keys the client actually sent are written, so a partial PATCH cannot
    // blank a field it never mentioned.
    const data: Prisma.ProjectUpdateManyMutationInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.description !== undefined) data.description = parsed.data.description;
    if (parsed.data.instructions !== undefined) data.instructions = parsed.data.instructions;
    if (parsed.data.memory !== undefined) {
      // Prisma distinguishes SQL NULL from JSON null; DbNull clears the column.
      data.memory =
        parsed.data.memory === null
          ? Prisma.DbNull
          : (parsed.data.memory as unknown as Prisma.InputJsonValue);
    }
    if (parsed.data.archived !== undefined) {
      // Archiving is presentation-only: conversations and artifacts are untouched.
      data.archivedAt = parsed.data.archived ? new Date() : null;
    }

    // Ownership is enforced by the update filter itself.
    const result = await prisma.project.updateMany({
      where: { id: params.id, userId },
      data,
    });

    if (result.count === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const project = await prisma.project.findFirst({
      where: { id: params.id, userId },
      select: projectSelect,
    });

    if (!project) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    logger.error("Failed to update project", {
      projectId: params.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const limited = enforceRateLimit("projects", request, userId);
    if (limited) return limited;

    // Conversations survive: Conversation.projectId is onDelete: SetNull, so deleting
    // a project unfiles its chats rather than destroying them.
    const result = await prisma.project.deleteMany({
      where: { id: params.id, userId },
    });

    if (result.count === 0) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete project", {
      projectId: params.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Failed to delete project" }, { status: 500 });
  }
}
