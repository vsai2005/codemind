type PriorityBadgeProps = {
  priority: "LOW" | "MEDIUM" | "HIGH";
};

const priorityConfig: Record<
  PriorityBadgeProps["priority"],
  { label: string; className: string }
> = {
  LOW: {
    label: "Low",
    className: "bg-slate-100 text-slate-700",
  },
  MEDIUM: {
    label: "Medium",
    className: "bg-yellow-100 text-yellow-800",
  },
  HIGH: {
    label: "High",
    className: "bg-red-100 text-red-800",
  },
};

export function PriorityBadge({ priority }: PriorityBadgeProps): React.ReactElement {
  const config = priorityConfig[priority];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
