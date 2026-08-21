"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ProjectSettings } from "@/components/projects/ProjectSettings";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Project workspace.
 *
 * One project seen from four angles: the chats that live in it, the artifacts those
 * chats produced, the memory the project has accumulated, and its settings.
 *
 * Each tab owns its data and fetches it the first time it is opened, then keeps it in
 * state — switching back and forth never refetches. Only an explicit mutation (rename,
 * move, delete) or the retry button re-hits the network. Every response is narrowed by
 * a type guard rather than cast, so a malformed body degrades into that tab's error
 * state instead of crashing the page.
 */

// --- Types --------------------------------------------------------------

type TabId = "chats" | "files" | "memory" | "settings";

interface TabDescriptor {
  id: TabId;
  label: string;
}

const TABS: ReadonlyArray<TabDescriptor> = [
  { id: "chats", label: "Chats" },
  { id: "files", label: "Files" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "Settings" },
];

export interface MemorySection {
  title: string;
  items: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  memory: MemorySection[] | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
}

export interface ProjectConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ProjectArtifact {
  id: string;
  type: string;
  filename: string;
  fileCount: number;
  byteSize: number;
  createdAt: string;
  conversationId: string | null;
  conversationTitle: string | null;
}

/** Per-tab request lifecycle. `idle` means "never opened", which is what makes loading lazy. */
type Async<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

// --- Narrowing helpers --------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseMemory(value: unknown): MemorySection[] | null {
  if (!Array.isArray(value)) return null;

  const sections: MemorySection[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;

    const title = asString(record.title);
    if (title === null) continue;

    sections.push({
      title,
      items: Array.isArray(record.items)
        ? record.items.filter((item): item is string => typeof item === "string")
        : [],
    });
  }

  return sections.length > 0 ? sections : null;
}

function parseProject(body: unknown): ProjectSummary | null {
  const root = asRecord(body);
  const project = root ? asRecord(root.project) : null;
  if (!project) return null;

  const id = asString(project.id);
  const name = asString(project.name);
  if (id === null || name === null) return null;

  return {
    id,
    name,
    description: asString(project.description),
    instructions: asString(project.instructions),
    memory: parseMemory(project.memory),
    archivedAt: asString(project.archivedAt),
    createdAt: asString(project.createdAt) ?? "",
    updatedAt: asString(project.updatedAt) ?? "",
    conversationCount: asCount(project.conversationCount),
  };
}

function parseConversations(body: unknown): ProjectConversation[] | null {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.conversations)) return null;

  const conversations: ProjectConversation[] = [];
  for (const entry of root.conversations) {
    const record = asRecord(entry);
    if (!record) continue;

    const id = asString(record.id);
    if (id === null) continue;

    conversations.push({
      id,
      title: asString(record.title),
      createdAt: asString(record.createdAt) ?? "",
      updatedAt: asString(record.updatedAt) ?? asString(record.createdAt) ?? "",
      messageCount: asCount(record.messageCount),
    });
  }

  return conversations;
}

function parseArtifacts(body: unknown): ProjectArtifact[] | null {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.artifacts)) return null;

  const artifacts: ProjectArtifact[] = [];
  for (const entry of root.artifacts) {
    const record = asRecord(entry);
    if (!record) continue;

    const id = asString(record.id);
    const filename = asString(record.filename);
    if (id === null || filename === null) continue;

    artifacts.push({
      id,
      filename,
      type: asString(record.type) ?? "file",
      fileCount: asCount(record.fileCount),
      byteSize: asCount(record.byteSize),
      createdAt: asString(record.createdAt) ?? "",
      conversationId: asString(record.conversationId),
      conversationTitle: asString(record.conversationTitle),
    });
  }

  return artifacts;
}

async function fetchJson<T>(url: string, parse: (body: unknown) => T | null): Promise<T> {
  const response = await fetch(url);
  if (response.status === 404) throw new Error("This project no longer exists.");
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);

  const parsed = parse(await response.json());
  if (parsed === null) throw new Error("The server sent something unexpected.");
  return parsed;
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

// --- Formatting ---------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Relative timestamp, deliberately hand-rolled — a whole date library would be a heavy
 * dependency for six branches. Anything in the future (clock skew) reads as "just now".
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const elapsed = Date.now() - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${plural(Math.floor(elapsed / MINUTE), "minute")} ago`;
  if (elapsed < DAY) return `${plural(Math.floor(elapsed / HOUR), "hour")} ago`;
  if (elapsed < 7 * DAY) return `${plural(Math.floor(elapsed / DAY), "day")} ago`;
  if (elapsed < 30 * DAY) return `${plural(Math.floor(elapsed / (7 * DAY)), "week")} ago`;
  if (elapsed < 365 * DAY) return `${plural(Math.floor(elapsed / (30 * DAY)), "month")} ago`;
  return `${plural(Math.floor(elapsed / (365 * DAY)), "year")} ago`;
}

function formatBytes(bytes: number): string | null {
  if (bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeArtifactType(type: string): "zip" | "pdf" | "file" {
  if (type === "zip") return "zip";
  if (type === "pdf") return "pdf";
  return "file";
}

function describeArtifact(artifact: ProjectArtifact): string {
  const parts: string[] = [];
  if (artifact.fileCount > 0) parts.push(plural(artifact.fileCount, "file"));

  const size = formatBytes(artifact.byteSize);
  if (size) parts.push(size);
  if (artifact.createdAt) parts.push(formatRelativeTime(artifact.createdAt));

  return parts.join(" · ");
}

// --- Small presentational pieces ---------------------------------------

function ArtifactIcon({ type }: { type: string }): React.ReactElement {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (type === "zip") {
    return (
      <svg {...common}>
        <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6l2 3h6a2 2 0 0 1 2 2Z" />
        <path d="M12 11v2m0 2v2" />
      </svg>
    );
  }

  if (type === "pdf") {
    return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
        <path d="M9 15h6" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="m10 13-2 2 2 2" />
      <path d="m14 13 2 2-2 2" />
    </svg>
  );
}

/** Rows and skeletons share a height so first paint never shifts the layout. */
function RowSkeleton({ rows = 3 }: { rows?: number }): React.ReactElement {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-[62px] animate-pulse rounded-lg border border-gray-200 bg-gray-50"
        />
      ))}
    </div>
  );
}

function ErrorState({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-[13px] font-semibold text-gray-900">{title}</p>
      <p className="mt-1 break-words text-[13px] text-gray-500">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
      >
        Try again
      </button>
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-8 text-center">
      <p className="text-[13px] font-semibold text-gray-900">{title}</p>
      <p className="mx-auto mt-1 max-w-sm break-words text-[13px] text-gray-500">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// --- Row overflow menu --------------------------------------------------

interface RowMenuProps {
  /** Used for the trigger's accessible name, so screen readers hear which row this is. */
  label: string;
  busy: boolean;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}

/**
 * Hover-revealed row actions.
 *
 * The trigger stays in the tab order even while visually hidden and reappears on
 * focus-within, so the menu is reachable without a pointer. On touch widths there is no
 * hover to reveal it, so it is simply always visible.
 */
function RowMenu({ label, busy, onRename, onMove, onDelete }: RowMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const moveFocus = (delta: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
    if (items.length === 0) return;

    const current = items.findIndex((item) => item === document.activeElement);
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const run = (action: () => void): void => {
    setOpen(false);
    action();
  };

  const items: Array<{ key: string; label: string; danger?: boolean; action: () => void }> = [
    { key: "rename", label: "Rename", action: onRename },
    { key: "move", label: "Move out of project", action: onMove },
    { key: "delete", label: "Delete", danger: true, action: onDelete },
  ];

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        onClick={() => (open ? close(true) : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${label}`}
        className={`flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-gray-900 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${
          open ? "bg-gray-100 text-gray-700 sm:opacity-100" : ""
        }`}
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        )}
      </button>

      {open && (
        // Anchored to the trigger's right edge: body sets overflow-x:hidden, so a panel
        // that spilled past the viewport would be clipped rather than scrollable.
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${label}`}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-20 mt-1 w-[min(12rem,calc(100vw-3rem))] overflow-hidden rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              onClick={() => run(item.action)}
              className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:bg-gray-50 ${
                item.danger
                  ? "text-red-600 hover:bg-red-50 focus-visible:bg-red-50"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Workspace ----------------------------------------------------------

export function ProjectWorkspace({ projectId }: { projectId: string }): React.ReactElement {
  const baseId = useId();

  const [activeTab, setActiveTab] = useState<TabId>("chats");
  const router = useRouter();
  const [project, setProject] = useState<Async<ProjectSummary>>({ status: "idle" });
  const [conversations, setConversations] = useState<Async<ProjectConversation[]>>({ status: "idle" });
  const [artifacts, setArtifacts] = useState<Async<ProjectArtifact[]>>({ status: "idle" });

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const aliveRef = useRef(true);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const renameInputRef = useRef<HTMLInputElement>(null);
  /** Set by Escape so the blur that follows does not commit the abandoned edit. */
  const renameCancelledRef = useRef(false);
  /** Guards against a duplicate first fetch when effects run twice in development. */
  const startedRef = useRef({ conversations: false, artifacts: false });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // --- Loaders ----------------------------------------------------------

  const loadProject = useCallback(async () => {
    setProject({ status: "loading" });
    try {
      const data = await fetchJson(`/api/projects/${projectId}`, parseProject);
      if (aliveRef.current) setProject({ status: "ready", data });
    } catch (error) {
      if (aliveRef.current) setProject({ status: "error", message: messageFor(error) });
    }
  }, [projectId]);

  const loadConversations = useCallback(async () => {
    startedRef.current.conversations = true;
    setConversations({ status: "loading" });
    try {
      const data = await fetchJson(`/api/projects/${projectId}/conversations`, parseConversations);
      if (aliveRef.current) setConversations({ status: "ready", data });
    } catch (error) {
      startedRef.current.conversations = false;
      if (aliveRef.current) setConversations({ status: "error", message: messageFor(error) });
    }
  }, [projectId]);

  const loadArtifacts = useCallback(async () => {
    startedRef.current.artifacts = true;
    setArtifacts({ status: "loading" });
    try {
      const data = await fetchJson(`/api/projects/${projectId}/artifacts`, parseArtifacts);
      if (aliveRef.current) setArtifacts({ status: "ready", data });
    } catch (error) {
      startedRef.current.artifacts = false;
      if (aliveRef.current) setArtifacts({ status: "error", message: messageFor(error) });
    }
  }, [projectId]);

  // The header, Memory and Settings all read the project, so it loads up front.
  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  // Tab data is fetched on first activation and then kept: returning to a tab is free.
  useEffect(() => {
    if (activeTab === "chats" && !startedRef.current.conversations) void loadConversations();
    if (activeTab === "files" && !startedRef.current.artifacts) void loadArtifacts();
  }, [activeTab, loadConversations, loadArtifacts]);

  useEffect(() => {
    if (editingId === null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editingId]);

  // --- Tab keyboard navigation -----------------------------------------

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const current = TABS.findIndex((tab) => tab.id === activeTab);

    let next = -1;
    if (event.key === "ArrowRight") next = (current + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;

    event.preventDefault();
    const target = TABS[next];
    if (!target) return;

    setActiveTab(target.id);
    tabRefs.current[next]?.focus();
  };

  // --- Conversation mutations ------------------------------------------

  const startRename = (conversation: ProjectConversation): void => {
    renameCancelledRef.current = false;
    setActionError(null);
    setDraftTitle(conversation.title ?? "");
    setEditingId(conversation.id);
  };

  const commitRename = async (conversation: ProjectConversation): Promise<void> => {
    const title = draftTitle.trim();
    setEditingId(null);

    if (title.length === 0 || title === (conversation.title ?? "")) return;

    // Optimistic: the row shows the new title immediately and only snaps back on failure.
    setConversations((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            data: current.data.map((entry) =>
              entry.id === conversation.id ? { ...entry, title } : entry
            ),
          }
        : current
    );

    setBusyConversationId(conversation.id);
    try {
      const response = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error(`Rename failed (${response.status}).`);
    } catch (error) {
      if (!aliveRef.current) return;
      setActionError(messageFor(error));
      void loadConversations();
    } finally {
      if (aliveRef.current) setBusyConversationId(null);
    }
  };

  const onRenameKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    conversation: ProjectConversation
  ): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename(conversation);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renameCancelledRef.current = true;
      setEditingId(null);
    }
  };

  const onRenameBlur = (conversation: ProjectConversation): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    void commitRename(conversation);
  };

  const moveOutOfProject = async (conversation: ProjectConversation): Promise<void> => {
    setActionError(null);
    setBusyConversationId(conversation.id);
    try {
      const response = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: null }),
      });
      if (!response.ok) throw new Error(`Could not move that chat (${response.status}).`);
      await loadConversations();
      void loadProject();
    } catch (error) {
      if (aliveRef.current) setActionError(messageFor(error));
    } finally {
      if (aliveRef.current) setBusyConversationId(null);
    }
  };

  const deleteConversation = async (conversation: ProjectConversation): Promise<void> => {
    const label = conversation.title || "New Conversation";
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;

    setActionError(null);
    setBusyConversationId(conversation.id);
    try {
      const response = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Could not delete that chat (${response.status}).`);
      await loadConversations();
      void loadProject();
    } catch (error) {
      if (aliveRef.current) setActionError(messageFor(error));
    } finally {
      if (aliveRef.current) setBusyConversationId(null);
    }
  };

  // Same shape as the chat transcript's download: fetch, blob, synthetic anchor. File
  // bytes never round-trip through component state.
  const downloadArtifact = async (artifact: ProjectArtifact): Promise<void> => {
    setDownloadingId(artifact.id);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/download`);
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const record = asRecord(detail);
        alert(asString(record?.error) ?? "Failed to download this artifact.");
        return;
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch {
      alert("Failed to download this artifact.");
    } finally {
      if (aliveRef.current) setDownloadingId(null);
    }
  };

  // --- Header -----------------------------------------------------------

  const newChatHref = `/dashboard?project=${encodeURIComponent(projectId)}`;

  const newChatButton = (
    <Link
      href={newChatHref}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      New Chat
    </Link>
  );

  const backLink = (
    <Link
      href="/dashboard"
      className="inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
    >
      <span aria-hidden="true">←</span> Projects
    </Link>
  );

  if (project.status === "error") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6 md:py-8">
        {backLink}
        <div className="mt-6">
          <ErrorState
            title="Could not load this project"
            message={project.message}
            onRetry={() => void loadProject()}
          />
        </div>
      </div>
    );
  }

  const summary = project.status === "ready" ? project.data : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6 md:py-8">
      {backLink}

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {summary ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">
                  {summary.name}
                </h1>
                {summary.archivedAt && (
                  <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Archived
                  </span>
                )}
              </div>
              {summary.description ? (
                <p className="mt-1 break-words text-sm text-gray-500">{summary.description}</p>
              ) : (
                <p className="mt-1 text-sm italic text-gray-400">No description yet</p>
              )}
              <p className="mt-2 text-[11px] text-gray-400">
                {plural(summary.conversationCount, "chat")}
                {summary.updatedAt ? ` · updated ${formatRelativeTime(summary.updatedAt)}` : ""}
              </p>
            </>
          ) : (
            <div aria-hidden="true" className="space-y-2">
              <div className="h-7 w-48 animate-pulse rounded bg-gray-200" />
              <div className="h-4 w-64 animate-pulse rounded bg-gray-100" />
              <div className="h-3 w-28 animate-pulse rounded bg-gray-100" />
            </div>
          )}
        </div>
        {newChatButton}
      </div>

      {/* The strip scrolls inside itself; body has overflow-x:hidden, so overflow here
          would be clipped rather than reachable. */}
      <div className="mt-6 border-b border-gray-200">
        <div className="-mb-px overflow-x-auto">
          <div
            role="tablist"
            aria-label="Project sections"
            aria-orientation="horizontal"
            className="flex w-max min-w-full gap-1"
          >
            {TABS.map((tab, index) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={onTabKeyDown}
                  className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 ${
                    selected
                      ? "border-gray-900 text-gray-900"
                      : "border-transparent text-gray-500 hover:text-gray-900"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div
        id={`${baseId}-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        tabIndex={0}
        className="mt-5 focus:outline-none"
      >
        {activeTab === "chats" && (
          <>
            {actionError && (
              <p
                role="status"
                className="mb-3 break-words rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[13px] text-gray-600"
              >
                {actionError}
              </p>
            )}

            {(conversations.status === "idle" || conversations.status === "loading") && (
              <RowSkeleton />
            )}

            {conversations.status === "error" && (
              <ErrorState
                title="Could not load chats"
                message={conversations.message}
                onRetry={() => void loadConversations()}
              />
            )}

            {conversations.status === "ready" && conversations.data.length === 0 && (
              <EmptyState
                title="No chats yet"
                body="Chats you start inside this project will collect here."
                action={newChatButton}
              />
            )}

            {conversations.status === "ready" && conversations.data.length > 0 && (
              <ul className="space-y-2">
                {conversations.data.map((conversation) => {
                  const label = conversation.title || "New Conversation";
                  const busy = busyConversationId === conversation.id;
                  const editing = editingId === conversation.id;

                  return (
                    <li
                      key={conversation.id}
                      className="group flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 transition-colors hover:border-gray-300 focus-within:border-gray-300"
                    >
                      {editing ? (
                        <input
                          ref={renameInputRef}
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onKeyDown={(event) => onRenameKeyDown(event, conversation)}
                          onBlur={() => onRenameBlur(conversation)}
                          aria-label={`Rename ${label}`}
                          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1 text-[13px] font-medium text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                        />
                      ) : (
                        <Link
                          href={`/chat/${conversation.id}`}
                          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                        >
                          <span className="truncate text-[13px] font-medium text-gray-900">
                            {label}
                          </span>
                          <span className="truncate text-[11px] text-gray-500">
                            {formatRelativeTime(conversation.updatedAt)} ·{" "}
                            {plural(conversation.messageCount, "message")}
                          </span>
                        </Link>
                      )}

                      <RowMenu
                        label={label}
                        busy={busy}
                        onRename={() => startRename(conversation)}
                        onMove={() => void moveOutOfProject(conversation)}
                        onDelete={() => void deleteConversation(conversation)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {activeTab === "files" && (
          <>
            {(artifacts.status === "idle" || artifacts.status === "loading") && <RowSkeleton />}

            {artifacts.status === "error" && (
              <ErrorState
                title="Could not load files"
                message={artifacts.message}
                onRetry={() => void loadArtifacts()}
              />
            )}

            {artifacts.status === "ready" && artifacts.data.length === 0 && (
              <EmptyState
                title="No files yet"
                body="When a chat in this project generates a project zip, a PDF or a source file, it shows up here ready to download."
              />
            )}

            {artifacts.status === "ready" && artifacts.data.length > 0 && (
              <ul className="space-y-2">
                {artifacts.data.map((artifact) => {
                  const type = normalizeArtifactType(artifact.type);
                  const busy = downloadingId === artifact.id;

                  return (
                    <li
                      key={artifact.id}
                      className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-600">
                        <ArtifactIcon type={type} />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-gray-900">
                            {artifact.filename}
                          </span>
                          <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                            {type}
                          </span>
                        </div>
                        <p className="truncate text-[11px] text-gray-500">
                          {describeArtifact(artifact)}
                        </p>
                        {artifact.conversationId ? (
                          <Link
                            href={`/chat/${artifact.conversationId}`}
                            className="block truncate rounded text-[11px] text-gray-400 transition-colors hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                          >
                            From {artifact.conversationTitle || "New Conversation"}
                          </Link>
                        ) : (
                          <p className="truncate text-[11px] text-gray-400">
                            From {artifact.conversationTitle || "a deleted conversation"}
                          </p>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => void downloadArtifact(artifact)}
                        disabled={busy}
                        aria-label={`Download ${artifact.filename}`}
                        className="flex shrink-0 items-center gap-1.5 rounded-md bg-gray-100 px-2.5 py-1.5 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:opacity-50"
                      >
                        {busy ? (
                          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
                        ) : (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                        )}
                        <span className="hidden sm:inline">
                          {busy ? "Downloading…" : "Download"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {activeTab === "memory" && (
          <>
            {!summary && <RowSkeleton rows={2} />}

            {summary && (!summary.memory || summary.memory.length === 0) && (
              <EmptyState
                title="Nothing remembered yet"
                body="As you work in this project, the facts and decisions worth keeping are collected here."
              />
            )}

            {summary && summary.memory && summary.memory.length > 0 && (
              <div className="space-y-4">
                <p className="text-[11px] text-gray-400">
                  Read-only here — memory is edited in Settings.
                </p>
                {summary.memory.map((section, index) => (
                  <section
                    key={`${section.title}-${index}`}
                    className="rounded-lg border border-gray-200 bg-white p-4"
                  >
                    <h2 className="break-words text-[13px] font-semibold text-gray-900">
                      {section.title}
                    </h2>
                    {section.items.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {section.items.map((item, itemIndex) => (
                          <li
                            key={`${item}-${itemIndex}`}
                            className="flex gap-2 break-words text-[13px] text-gray-600"
                          >
                            <span aria-hidden="true" className="text-gray-300">
                              •
                            </span>
                            <span className="min-w-0">{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[13px] italic text-gray-400">Nothing here yet</p>
                    )}
                  </section>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === "settings" && (
          <>
            {!summary && <RowSkeleton rows={2} />}

            {summary && (
              <ProjectSettings
                project={{
                  id: summary.id,
                  name: summary.name,
                  description: summary.description,
                  instructions: summary.instructions,
                  memory: summary.memory,
                  archivedAt: summary.archivedAt,
                }}
                // Keep the header, Memory tab and settings form reading one source of
                // truth, so a rename shows in the title immediately.
                onUpdated={(updated) =>
                  setProject((current) =>
                    current.status === "ready"
                      ? { status: "ready", data: { ...current.data, ...updated } }
                      : current
                  )
                }
                onDeleted={() => router.push("/dashboard")}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
