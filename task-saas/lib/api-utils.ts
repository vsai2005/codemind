import { auth } from "@/auth";
import type { ApiError } from "@/types/task";

export function successResponse<T>(data: T, status: number = 200): Response {
  return Response.json({ data }, { status });
}

export function errorResponse(
  code: string,
  message: string,
  status: number
): Response {
  const error: ApiError = { code, message };
  return Response.json({ error }, { status });
}

export async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
