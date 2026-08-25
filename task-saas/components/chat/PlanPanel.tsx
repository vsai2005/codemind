"use client";

import { useId, useState } from "react";

/**
 * Collapsible plan shown above an assistant reply.
 *
 * This renders a user-facing SPECIFICATION — what CodeMind understood and how it
 * intends to approach the work. It is deliberately not called "thinking" and never
 * contains model deliberation; the planner is instructed to emit a plan, not reasoning.
 */

export interface PlanArea {
  name: string;
  items: string[];
}

export interface ChatPlan {
  intent: string;
  complexity: "simple" | "moderate" | "complex";
  summary: string;
  areas: PlanArea[];
  steps: string[];
}

/** Narrow unknown annotation/DB data into a ChatPlan without trusting its shape. */
export function parsePlan(value: unknown): ChatPlan | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.intent !== "string" || candidate.intent.trim().length === 0) return null;

  const areas = Array.isArray(candidate.areas)
    ? candidate.areas.flatMap((entry): PlanArea[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const area = entry as Record<string, unknown>;
        if (typeof area.name !== "string") return [];
        const items = Array.isArray(area.items)
          ? area.items.filter((i): i is string => typeof i === "string")
          : [];
        return items.length > 0 ? [{ name: area.name, items }] : [];
      })
    : [];

  const steps = Array.isArray(candidate.steps)
    ? candidate.steps.filter((s): s is string => typeof s === "string")
    : [];

  if (areas.length === 0 && steps.length === 0) return null;

  return {
    intent: candidate.intent,
    complexity:
      candidate.complexity === "simple" || candidate.complexity === "complex"
        ? candidate.complexity
        : "moderate",
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    areas,
    steps,
  };
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-[3px] shrink-0 text-gray-400"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function PlanPanel({ plan }: { plan: ChatPlan }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-gray-200 bg-gray-50/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-100/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-gray-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="text-[12px] font-semibold uppercase tracking-wide text-gray-600">
          CodeMind Planning
        </span>
        {!open && plan.summary && (
          <span className="ml-1 min-w-0 truncate text-[12px] text-gray-500">{plan.summary}</span>
        )}
      </button>

      {open && (
        <div id={panelId} className="border-t border-gray-200 px-4 py-3">
          <p className="text-[13px] font-medium text-gray-900">Understanding your request</p>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-600">{plan.intent}</p>

          {plan.areas.length > 0 && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {plan.areas.map((area) => (
                <div key={area.name}>
                  <p className="text-[12px] font-semibold text-gray-700">{area.name}</p>
                  <ul className="mt-1 space-y-1">
                    {area.items.map((item) => (
                      <li key={item} className="flex gap-1.5 text-[12px] leading-relaxed text-gray-600">
                        <CheckIcon />
                        <span className="min-w-0">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {plan.steps.length > 0 && (
            <div className="mt-3 border-t border-gray-200 pt-3">
              <p className="text-[12px] font-semibold text-gray-700">Approach</p>
              <ol className="mt-1 list-inside list-decimal space-y-1">
                {plan.steps.map((step) => (
                  <li key={step} className="text-[12px] leading-relaxed text-gray-600">
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
