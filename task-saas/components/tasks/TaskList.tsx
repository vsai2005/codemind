import { TaskCard } from "@/components/tasks/TaskCard";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Task } from "@/types/task";

type TaskListProps = {
  tasks: Task[];
};

export function TaskList({ tasks }: TaskListProps): React.ReactElement {
  if (tasks.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="grid gap-3">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  );
}
