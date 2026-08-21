import { prisma } from "@/lib/db";
import { UpdateTaskSchema } from "@/lib/validation";
import {
  successResponse,
  errorResponse,
  getAuthenticatedUserId,
} from "@/lib/api-utils";

interface RouteContext {
  params: { id: string };
}

export async function GET(
  _request: Request,
  { params }: RouteContext
): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  try {
    const task = await prisma.task.findFirst({
      where: {
        id: params.id,
        userId,
      },
    });

    if (!task) {
      return errorResponse("NOT_FOUND", "Task not found", 404);
    }

    return successResponse(task);
  } catch (error) {
    console.error("Failed to fetch task:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
}

export async function PUT(
  request: Request,
  { params }: RouteContext
): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", "Invalid JSON in request body", 400);
  }

  const parsed = UpdateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join(", "),
      400
    );
  }

  try {
    const updateData: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) updateData.title = parsed.data.title;
    if (parsed.data.description !== undefined) updateData.description = parsed.data.description || null;
    if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
    if (parsed.data.priority !== undefined) updateData.priority = parsed.data.priority;
    if (parsed.data.tags !== undefined) updateData.tags = parsed.data.tags;
    if (parsed.data.dueDate !== undefined) {
      updateData.dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null;
    }

    // Ownership is enforced by the write itself rather than a preceding read. A
    // scoped read followed by an unscoped update is a check-then-act pattern: correct
    // only while the two stay adjacent, and silently cross-tenant the moment a future
    // refactor moves the guard.
    const result = await prisma.task.updateMany({
      where: { id: params.id, userId },
      data: updateData,
    });

    if (result.count === 0) {
      return errorResponse("NOT_FOUND", "Task not found", 404);
    }

    const task = await prisma.task.findFirst({ where: { id: params.id, userId } });
    if (!task) {
      return errorResponse("NOT_FOUND", "Task not found", 404);
    }

    return successResponse(task);
  } catch (error) {
    console.error("Failed to update task:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteContext
): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  try {
    // Same reasoning as PUT: the delete carries its own ownership predicate.
    const result = await prisma.task.deleteMany({
      where: { id: params.id, userId },
    });

    if (result.count === 0) {
      return errorResponse("NOT_FOUND", "Task not found", 404);
    }

    return successResponse({ success: true });
  } catch (error) {
    console.error("Failed to delete task:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
}
