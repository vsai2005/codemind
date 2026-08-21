"use client";

import type { JSONValue } from "ai";

/**
 * Shows what the server is doing.
 *
 * During artifact generation the server streams readable progress labels as data
 * parts ("Planning the project…", "Packaging ZIP…"). For normal chat there are no
 * data parts and this falls back to the animated dots.
 */

function latestProgressLabel(data: JSONValue[] | undefined): string | null {
  if (!Array.isArray(data)) return null;

  for (let i = data.length - 1; i >= 0; i--) {
    const entry = data[i];
    if (entry && typeof entry === "object" && "codemindProgress" in entry) {
      const progress = (entry as Record<string, unknown>).codemindProgress;
      if (progress && typeof progress === "object" && "label" in progress) {
        const label = (progress as Record<string, unknown>).label;
        if (typeof label === "string") return label;
      }
    }
  }
  return null;
}

export function ThinkingIndicator({ data }: { data?: JSONValue[] }): React.ReactElement {
  const label = latestProgressLabel(data);

  return (
    <div className="flex items-center gap-2.5 ml-4 text-sm text-gray-500">
      <div className="flex gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-75" />
        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-150" />
      </div>
      {label && <span className="font-medium">{label}</span>}
    </div>
  );
}
