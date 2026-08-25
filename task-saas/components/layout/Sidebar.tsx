"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import {
  BACKGROUND_REFRESH_MS,
  getWorkspaceServerSnapshot,
  getWorkspaceSnapshot,
  invalidateWorkspace,
  patchWorkspaceSnapshot,
  refreshWorkspace,
  subscribeToWorkspace,
} from "@/lib/client/workspace-data";

/**
 * Primary navigation.
 *
 * Two workspaces sit side by side: Projects (persistent, with their own
 * instructions and memory) and Personal chats (everything not filed into one).
 * A conversation is never forced into a project — the Personal section is a
 * first-class home, not a leftover bucket.
 *
 * Both sections collapse so a user with many projects can keep the rail readable.
 *
 * Archived projects get their own disclosure below the active list. Archiving hides a
 * project; it has never deleted anything, and this is the way back — without it the
 * only route to an archived project was a URL the user had to have kept.
 *
 * Data comes from the shared workspace store rather than a private poll, so the
 * switcher in the chat header reads the same cache and mutations refresh both at once.
 */

interface ArchivedProject {
  id: string;
  name: string;
}

interface ArchivedConversation {
  id: string;
  title: string | null;
}

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-gray-400 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between pr-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex flex-1 items-center gap-1.5 rounded-[6px] px-2 py-1 text-left transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        <ChevronIcon open={open} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          {label}
        </span>
      </button>
      {action}
    </div>
  );
}

export function Sidebar(): React.ReactElement {
  const { projects, conversations, loaded } = useSyncExternalStore(
    subscribeToWorkspace,
    getWorkspaceSnapshot,
    getWorkspaceServerSnapshot
  );

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<ArchivedProject[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [archivedChatsOpen, setArchivedChatsOpen] = useState(false);
  const [archivedChats, setArchivedChats] = useState<ArchivedConversation[]>([]);
  const [archivedChatsLoaded, setArchivedChatsLoaded] = useState(false);
  const [restoringChatId, setRestoringChatId] = useState<string | null>(null);

  const router = useRouter();
  const pathname = usePathname();

  // One initial load, a focus listener for changes made elsewhere, and a slow
  // safety-net interval that does nothing while the tab is hidden.
  useEffect(() => {
    void refreshWorkspace();

    const onFocus = (): void => {
      if (document.visibilityState === "visible") void refreshWorkspace();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refreshWorkspace();
    }, BACKGROUND_REFRESH_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(interval);
    };
  }, []);

  const loadArchived = useCallback(async () => {
    try {
      const response = await fetch("/api/projects?archived=1");
      if (!response.ok) return;
      const body: unknown = await response.json();
      const list = Array.isArray(body) ? body : (body as { projects?: unknown }).projects;
      if (!Array.isArray(list)) return;

      setArchived(
        list.flatMap((entry): ArchivedProject[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const row = entry as Record<string, unknown>;
          // ?archived=1 returns active projects too; only the archived ones belong here.
          if (typeof row.archivedAt !== "string") return [];
          return typeof row.id === "string" && typeof row.name === "string"
            ? [{ id: row.id, name: row.name }]
            : [];
        })
      );
    } catch {
      // Leave whatever was already listed; the disclosure simply shows nothing new.
    } finally {
      setArchivedLoaded(true);
    }
  }, []);

  // Fetched only when the user opens the disclosure — archived projects are rare and
  // should not cost a request on every page load.
  useEffect(() => {
    if (archivedOpen) void loadArchived();
  }, [archivedOpen, loadArchived]);

  const restoreProject = async (id: string): Promise<void> => {
    if (restoringId) return;
    setRestoringId(id);
    try {
      const response = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (!response.ok) return;

      setArchived((current) => current.filter((project) => project.id !== id));
      invalidateWorkspace();
      router.push(`/projects/${id}`);
    } catch {
      // Nothing was changed server-side; the row stays in the archived list.
    } finally {
      setRestoringId(null);
    }
  };

  const loadArchivedChats = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations?archived=1");
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return;

      setArchivedChats(
        body.flatMap((entry): ArchivedConversation[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const row = entry as Record<string, unknown>;
          // ?archived=1 returns active conversations too; only archived ones belong here.
          if (typeof row.archivedAt !== "string") return [];
          return typeof row.id === "string"
            ? [{ id: row.id, title: typeof row.title === "string" ? row.title : null }]
            : [];
        })
      );
    } catch {
      // Leave whatever was already listed; the disclosure simply shows nothing new.
    } finally {
      setArchivedChatsLoaded(true);
    }
  }, []);

  // Fetched only when the user opens the disclosure — same reasoning as loadArchived.
  useEffect(() => {
    if (archivedChatsOpen) void loadArchivedChats();
  }, [archivedChatsOpen, loadArchivedChats]);

  const archiveConversation = async (id: string, event: React.MouseEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();

    const response = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    if (!response.ok) return;

    // Optimistic, then reconciled: matches deleteConversation's pattern below.
    patchWorkspaceSnapshot((current) => ({
      ...current,
      conversations: current.conversations.filter((c) => c.id !== id),
    }));
    invalidateWorkspace();
    // The archived list is stale until the user reopens the disclosure; if it is
    // already open, drop the fetch cost and reflect the change immediately.
    if (archivedChatsOpen) void loadArchivedChats();

    if (pathname === `/chat/${id}`) router.push("/dashboard");
  };

  const restoreConversation = async (id: string): Promise<void> => {
    if (restoringChatId) return;
    setRestoringChatId(id);
    try {
      const response = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (!response.ok) return;

      setArchivedChats((current) => current.filter((chat) => chat.id !== id));
      invalidateWorkspace();
      router.push(`/chat/${id}`);
    } catch {
      // Nothing was changed server-side; the row stays in the archived list.
    } finally {
      setRestoringChatId(null);
    }
  };

  const deleteConversation = async (id: string, event: React.MouseEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm("Delete this conversation?")) return;

    await fetch(`/api/conversations/${id}`, { method: "DELETE" });

    // Optimistic, then reconciled: the row disappears on click rather than after the
    // next refresh.
    patchWorkspaceSnapshot((current) => ({
      ...current,
      conversations: current.conversations.filter((c) => c.id !== id),
    }));
    invalidateWorkspace();

    if (pathname === `/chat/${id}`) router.push("/dashboard");
  };

  // Only conversations outside a project belong in Personal.
  const personalChats = conversations.filter((c) => c.projectId === null);

  return (
    <>
      <div className="fixed left-0 top-0 z-50 hidden h-screen w-64 flex-col border-r border-gray-200 bg-[#F9FAFB] text-gray-600 md:flex">
        <div className="flex h-14 items-center border-b border-gray-200 px-4">
          <Link
            href="/dashboard"
            className="text-[15px] font-semibold tracking-tight text-gray-900 transition-opacity hover:opacity-80"
          >
            CodeMind
          </Link>
        </div>

        <div className="p-3">
          <Link
            href="/dashboard"
            className="flex w-full items-center gap-2 rounded-card bg-accent-600 px-3 py-2 text-sm font-medium text-white shadow-elevated transition-colors hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
          >
            <span className="text-accent-200">+</span> New Chat
          </Link>
        </div>

        <div className="scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent flex-1 overflow-y-auto px-2 pb-2">
          {/* --- Projects ------------------------------------------------- */}
          <SectionHeader
            label="Projects"
            open={projectsOpen}
            onToggle={() => setProjectsOpen((v) => !v)}
            action={
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                aria-label="New project"
                title="New project"
                className="rounded-[6px] p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            }
          />

          {projectsOpen && (
            <div className="mb-3 mt-1 space-y-[2px]">
              {projects.map((project) => {
                const isActive = pathname === `/projects/${project.id}`;
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className={`flex items-center gap-2 truncate rounded-[6px] px-2 py-[6px] text-[13px] font-medium transition-colors ${
                      isActive ? "bg-accent-50 text-accent-900" : "hover:bg-gray-100"
                    }`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={`shrink-0 transition-colors ${isActive ? "text-accent-500" : "text-gray-400"}`} aria-hidden="true">
                      <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6l2 3h6a2 2 0 0 1 2 2Z" />
                    </svg>
                    <span className="min-w-0 truncate">{project.name}</span>
                  </Link>
                );
              })}

              {loaded && projects.length === 0 && (
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className="w-full rounded-[6px] px-2 py-[6px] text-left text-[12px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                >
                  Create your first project
                </button>
              )}

              {/* --- Archived ------------------------------------------- */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setArchivedOpen((v) => !v)}
                  aria-expanded={archivedOpen}
                  className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[5px] text-left text-[12px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  <ChevronIcon open={archivedOpen} />
                  <span>Archived</span>
                  {archivedOpen && archivedLoaded && archived.length > 0 && (
                    <span className="ml-auto tabular-nums text-gray-400">{archived.length}</span>
                  )}
                </button>

                {archivedOpen && (
                  <div className="mt-[2px] space-y-[2px]">
                    {archived.map((project) => (
                      <div
                        key={project.id}
                        className="group flex items-center justify-between rounded-[6px] hover:bg-gray-100"
                      >
                        <Link
                          href={`/projects/${project.id}`}
                          className="min-w-0 flex-1 truncate px-2 py-[6px] text-[13px] text-gray-500"
                        >
                          {project.name}
                        </Link>
                        <button
                          type="button"
                          onClick={() => void restoreProject(project.id)}
                          disabled={restoringId === project.id}
                          title="Restore this project to the sidebar"
                          className="mr-1 shrink-0 rounded-[4px] px-1.5 py-[3px] text-[11px] font-medium text-gray-500 transition-colors hover:bg-white hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50"
                        >
                          {restoringId === project.id ? "Restoring…" : "Restore"}
                        </button>
                      </div>
                    ))}

                    {archivedLoaded && archived.length === 0 && (
                      <p className="px-2 py-1 text-[12px] text-gray-400">No archived projects</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* --- Personal chats -------------------------------------------- */}
          <SectionHeader
            label="Personal"
            open={chatsOpen}
            onToggle={() => setChatsOpen((v) => !v)}
          />

          {chatsOpen && (
            <div className="mt-1 space-y-[2px]">
              {personalChats.map((conv) => {
                const isActive = pathname === `/chat/${conv.id}`;
                return (
                  <div
                    key={conv.id}
                    className={`group flex items-center justify-between rounded-[6px] ${
                      isActive ? "bg-accent-50 text-accent-900" : "hover:bg-gray-100"
                    }`}
                  >
                    <Link
                      href={`/chat/${conv.id}`}
                      className="flex-1 truncate px-2 py-[6px] text-[13px] font-medium transition-colors"
                    >
                      {conv.title || "New Conversation"}
                    </Link>
                    <button
                      onClick={(e) => void archiveConversation(conv.id, e)}
                      aria-label="Archive conversation"
                      title="Archive conversation"
                      className="p-1 text-gray-400 opacity-0 transition-opacity hover:text-gray-700 focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="4" rx="1" />
                        <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
                        <path d="M10 13h4" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => void deleteConversation(conv.id, e)}
                      aria-label="Delete conversation"
                      title="Delete conversation"
                      className="mr-1 p-1 text-gray-400 opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}

              {loaded && personalChats.length === 0 && (
                <p className="px-2 py-1 text-[12px] text-gray-500">No personal chats yet</p>
              )}

              {/* --- Archived chats --------------------------------------- */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setArchivedChatsOpen((v) => !v)}
                  aria-expanded={archivedChatsOpen}
                  className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[5px] text-left text-[12px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  <ChevronIcon open={archivedChatsOpen} />
                  <span>Archived</span>
                  {archivedChatsOpen && archivedChatsLoaded && archivedChats.length > 0 && (
                    <span className="ml-auto tabular-nums text-gray-400">{archivedChats.length}</span>
                  )}
                </button>

                {archivedChatsOpen && (
                  <div className="mt-[2px] space-y-[2px]">
                    {archivedChats.map((chat) => (
                      <div
                        key={chat.id}
                        className="group flex items-center justify-between rounded-[6px] hover:bg-gray-100"
                      >
                        <Link
                          href={`/chat/${chat.id}`}
                          className="min-w-0 flex-1 truncate px-2 py-[6px] text-[13px] text-gray-500"
                        >
                          {chat.title || "New Conversation"}
                        </Link>
                        <button
                          type="button"
                          onClick={() => void restoreConversation(chat.id)}
                          disabled={restoringChatId === chat.id}
                          title="Restore this conversation to Personal"
                          className="mr-1 shrink-0 rounded-[4px] px-1.5 py-[3px] text-[11px] font-medium text-gray-500 transition-colors hover:bg-white hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50"
                        >
                          {restoringChatId === chat.id ? "Restoring…" : "Restore"}
                        </button>
                      </div>
                    ))}

                    {archivedChatsLoaded && archivedChats.length === 0 && (
                      <p className="px-2 py-1 text-[12px] text-gray-400">No archived chats</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <AccountMenu />
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(project) => {
          invalidateWorkspace();
          router.push(`/projects/${project.id}`);
        }}
      />
    </>
  );
}
