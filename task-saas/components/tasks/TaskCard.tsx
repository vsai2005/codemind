import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import type { Task } from "@/types/task";

type TaskCardProps = {
  task: Task;
};

export function TaskCard({ task }: TaskCardProps): React.ReactElement {
  return (
    <Link
      href={`/tasks/${task.id}`}
      className="block rounded-lg border bg-white p-4 shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold text-gray-900 line-clamp-1">
          {task.title}
        </h3>
        <div className="ml-2 flex shrink-0 gap-1.5">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
        </div>
      </div>
      {task.description && (
        <p className="mt-2 text-sm text-gray-600 line-clamp-2">
          {task.description}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        {task.dueDate && (
          <span className="text-xs text-gray-500">
            Due: {new Date(task.dueDate).toLocaleDateString()}
          </span>
        )}
        {task.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
