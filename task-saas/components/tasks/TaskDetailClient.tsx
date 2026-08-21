"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TaskForm } from "@/components/tasks/TaskForm";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { deleteTask } from "@/lib/api-client";
import type { Task } from "@/types/task";

type TaskDetailClientProps = {
  task: Task;
};

export function TaskDetailClient({ task }: TaskDetailClientProps): React.ReactElement {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (): Promise<void> => {
    if (!confirm("Are you sure you want to delete this task?")) return;

    setIsDeleting(true);
    setError(null);
    try {
      await deleteTask(task.id);
      router.refresh();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setIsDeleting(false);
    }
  };

  if (isEditing) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Edit Task</h1>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <TaskForm mode="edit" task={task} />
        </div>
        <button
          onClick={() => setIsEditing(false)}
          className="mt-4 text-sm text-gray-600 underline hover:text-gray-800"
        >
          Cancel editing
        </button>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{task.title}</h1>
          <div className="ml-4 flex shrink-0 gap-2">
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
          </div>
        </div>

        {task.description && (
          <p className="mt-4 text-gray-700 whitespace-pre-wrap">{task.description}</p>
        )}

        <div className="mt-6 border-t pt-4">
          <dl className="grid grid-cols-2 gap-4 text-sm">
            {task.dueDate && (
              <div>
                <dt className="font-medium text-gray-500">Due Date</dt>
                <dd className="mt-1 text-gray-900">
                  {new Date(task.dueDate).toLocaleDateString()}
                </dd>
              </div>
            )}
            <div>
              <dt className="font-medium text-gray-500">Created</dt>
              <dd className="mt-1 text-gray-900">
                {new Date(task.createdAt).toLocaleDateString()}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-gray-500">Updated</dt>
              <dd className="mt-1 text-gray-900">
                {new Date(task.updatedAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        </div>

        {task.tags.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <span className="text-sm font-medium text-gray-500">Tags:</span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {task.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-4">
        <button
          onClick={() => router.push("/dashboard")}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
        >
          Back to Dashboard
        </button>
        <button
          onClick={() => setIsEditing(true)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          disabled={isDeleting}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDeleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </div>
  );
}
