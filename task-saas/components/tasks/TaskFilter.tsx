"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export function TaskFilter(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentStatus = searchParams.get("status") ?? "";
  const currentPriority = searchParams.get("priority") ?? "";

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.push(`/dashboard?${params.toString()}`);
    },
    [router, searchParams]
  );

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <label
          htmlFor="status-filter"
          className="text-sm font-medium text-gray-700"
        >
          Status:
        </label>
        <select
          id="status-filter"
          value={currentStatus}
          onChange={(e) => updateFilter("status", e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All</option>
          <option value="TODO">To Do</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="DONE">Done</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label
          htmlFor="priority-filter"
          className="text-sm font-medium text-gray-700"
        >
          Priority:
        </label>
        <select
          id="priority-filter"
          value={currentPriority}
          onChange={(e) => updateFilter("priority", e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All</option>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
        </select>
      </div>
      {(currentStatus || currentPriority) && (
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 underline hover:text-blue-800"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
