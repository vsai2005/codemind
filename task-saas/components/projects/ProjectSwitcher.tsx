"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Workspace indicator and switcher for the chat header.
 *
 * Answers "which workspace is CodeMind working inside right now?" at a glance, and
 * lets the user move to another one. Personal Chat is an explicit entry rather than
 * an absence, so leaving a project is as deliberate as entering one.
 *
 * Switching navigates; it never reassigns the conversation you are currently reading.
 * Moving an existing conversation between workspaces lives in the project workspace,
 * where the consequence is visible.
 */

interface ProjectOption {
  id: string;
  name: string;
}

interface ProjectSwitcherProps {
  /** Project the current conversation belongs to, or null for a personal chat. */
  activeProjectId: string | null;
  /** Called with the chosen project id, or null for Personal Chat. */
  onSwitch?: (projectId: string | null) => void;
}

const PERSONAL_LABEL = "Personal Chat";

export function ProjectSwitcher({
  activeProjectId,
  onSwitch,
}: ProjectSwitcherProps): React.ReactElement {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) return;
        const body: unknown = await res.json();
        const list = Array.isArray(body) ? body : (body as { projects?: unknown }).projects;
        if (!Array.isArray(list) || cancelled) return;

        setProjects(
          list.flatMap((entry): ProjectOption[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const row = entry as Record<string, unknown>;
            return typeof row.id === "string" && typeof row.name === "string"
              ? [{ id: row.id, name: row.name }]
              : [];
          })
        );
      } catch {
        // Header degrades to the label alone; the chat itself is unaffected.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const activeName =
    projects.find((p) => p.id === activeProjectId)?.name ?? PERSONAL_LABEL;

  const choose = useCallback(
    (projectId: string | null) => {
      setOpen(false);
      if (onSwitch) {
        onSwitch(projectId);
        return;
      }
      router.push(projectId ? `/projects/${projectId}` : "/dashboard");
    },
    [onSwitch, router]
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-[220px] items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
      >
        <span className="min-w-0 truncate">{activeName}</span>
        <svg
          width="13"
          height="13"
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
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Switch workspace"
          // Right-aligned and viewport-capped: body has overflow-x hidden, so an
          // overflowing panel would be clipped rather than scrollable.
          className="absolute right-0 top-full z-50 mt-1 max-h-[60vh] w-[min(16rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={activeProjectId === null}
            onClick={() => choose(null)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition-colors hover:bg-gray-50"
          >
            <span className="truncate text-gray-700">{PERSONAL_LABEL}</span>
            {activeProjectId === null && <CheckMark />}
          </button>

          {projects.length > 0 && <div className="my-1 border-t border-gray-100" />}

          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected={project.id === activeProjectId}
              onClick={() => choose(project.id)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition-colors hover:bg-gray-50"
            >
              <span className="min-w-0 truncate text-gray-700">{project.name}</span>
              {project.id === activeProjectId && <CheckMark />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CheckMark(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-900" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
