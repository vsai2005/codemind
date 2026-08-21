import { prisma } from "@/lib/db";
import { CreateTaskSchema } from "@/lib/validation";
import {
  successResponse,
  errorResponse,
  getAuthenticatedUserId,
} from "@/lib/api-utils";
import type { TaskStatus, TaskPriority } from "@prisma/client";
import { enforceBodyLimit } from "@/lib/http/body-limit";

export async function GET(request: Request): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const priority = searchParams.get("priority");

  const where: { userId: string; status?: TaskStatus; priority?: TaskPriority } = {
    userId,
  };

  if (status && ["TODO", "IN_PROGRESS", "DONE"].includes(status)) {
    where.status = status as TaskStatus;
  }

  if (priority && ["LOW", "MEDIUM", "HIGH"].includes(priority)) {
    where.priority = priority as TaskPriority;
  }

  try {
    const tasks = await prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return successResponse(tasks);
  } catch (error) {
    console.error("Failed to fetch tasks:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  let body: unknown;
  try {
    const oversized = enforceBodyLimit(request, "json");
    if (oversized) return oversized;
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", "Invalid JSON in request body", 400);
  }

  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join(", "),
      400
    );
  }

  try {
    const task = await prisma.task.create({
      data: {
        title: parsed.data.title,
        description: parsed.data.description || null,
        status: parsed.data.status ?? "TODO",
        priority: parsed.data.priority ?? "MEDIUM",
        tags: parsed.data.tags ?? [],
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        userId,
      },
    });

    return successResponse(task, 201);
  } catch (error) {
    console.error("Failed to create task:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
}
