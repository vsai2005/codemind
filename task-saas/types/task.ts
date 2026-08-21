import type { Task as PrismaTask, TaskStatus, TaskPriority } from "@prisma/client";
import type { z } from "zod";
import type { CreateTaskSchema, UpdateTaskSchema } from "@/lib/validation";

// Re-export enums for convenience
export type { TaskStatus, TaskPriority } from "@prisma/client";

// Task type matching Prisma model
export type Task = PrismaTask;

// Input types derived from Zod schemas (single source of truth)
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

// API response types
export interface ApiError {
  code: string;
  message: string;
}

export interface ApiSuccessResponse<T> {
  data: T;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
