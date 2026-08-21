type StatusBadgeProps = {
  status: "TODO" | "IN_PROGRESS" | "DONE";
};

const statusConfig: Record<
  StatusBadgeProps["status"],
  { label: string; className: string }
> = {
  TODO: {
    label: "To Do",
    className: "bg-gray-100 text-gray-800",
  },
  IN_PROGRESS: {
    label: "In Progress",
    className: "bg-blue-100 text-blue-800",
  },
  DONE: {
    label: "Done",
    className: "bg-green-100 text-green-800",
  },
};

export function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  const config = statusConfig[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
