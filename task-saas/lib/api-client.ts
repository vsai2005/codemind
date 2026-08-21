import type { Task, CreateTaskInput, UpdateTaskInput, ApiSuccessResponse, ApiErrorResponse } from "@/types/task";

class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  const json = await response.json() as ApiSuccessResponse<T> | ApiErrorResponse;

  if (!response.ok) {
    const errorResponse = json as ApiErrorResponse;
    throw new ApiClientError(
      errorResponse.error?.code ?? "UNKNOWN_ERROR",
      errorResponse.error?.message ?? "An unexpected error occurred",
      response.status
    );
  }

  return (json as ApiSuccessResponse<T>).data;
}

export async function fetchTasks(params?: {
  status?: string;
  priority?: string;
}): Promise<Task[]> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
  if (params?.priority) searchParams.set("priority", params.priority);

  const query = searchParams.toString();
  const url = `/api/tasks${query ? `?${query}` : ""}`;

  const response = await fetch(url);
  return handleResponse<Task[]>(response);
}

export async function fetchTask(id: string): Promise<Task> {
  const response = await fetch(`/api/tasks/${id}`);
  return handleResponse<Task>(response);
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return handleResponse<Task>(response);
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput
): Promise<Task> {
  const response = await fetch(`/api/tasks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return handleResponse<Task>(response);
}

export async function deleteTask(id: string): Promise<void> {
  const response = await fetch(`/api/tasks/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const json = await response.json() as ApiErrorResponse;
    throw new ApiClientError(
      json.error?.code ?? "UNKNOWN_ERROR",
      json.error?.message ?? "An unexpected error occurred",
      response.status
    );
  }
}
