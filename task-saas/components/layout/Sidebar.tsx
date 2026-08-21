"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";

/**
 * Primary navigation.
 *
 * Two workspaces sit side by side: Projects (persistent, with their own
 * instructions and memory) and Personal chats (everything not filed into one).
 * A conversation is never forced into a project — the Personal section is a
 * first-class home, not a leftover bucket.
 *
 * Both sections collapse so a user with many projects can keep the rail readable.
 */

interface SidebarProject {
  id: string;
  name: string;
}

interface SidebarConversation {
  id: string;
  title: string | null;
  projectId: string | null;
}

const POLL_INTERVAL_MS = 5000;

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
        className="flex flex-1 items-center gap-1.5 rounded-[6px] px-2 py-1 text-left transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
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
  const [projects, setProjects] = useState<SidebarProject[]>([]);
  const [conversations, setConversations] = useState<SidebarConversation[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const [projectsRes, conversationsRes] = await Promise.all([
        fetch("/api/projects"),
        fetch("/api/conversations"),
      ]);

      if (projectsRes.ok) {
        const body: unknown = await projectsRes.json();
        const list = Array.isArray(body)
          ? body
          : (body as { projects?: unknown }).projects;
        if (Array.isArray(list)) {
          setProjects(
            list.flatMap((p): SidebarProject[] => {
              if (typeof p !== "object" || p === null) return [];
              const row = p as Record<string, unknown>;
              return typeof row.id === "string" && typeof row.name === "string"
                ? [{ id: row.id, name: row.name }]
                : [];
            })
          );
        }
      }

      if (conversationsRes.ok) {
        const body: unknown = await conversationsRes.json();
        if (Array.isArray(body)) {
          setConversations(
            body.flatMap((c): SidebarConversation[] => {
              if (typeof c !== "object" || c === null) return [];
              const row = c as Record<string, unknown>;
              if (typeof row.id !== "string") return [];
              return [
                {
                  id: row.id,
                  title: typeof row.title === "string" ? row.title : null,
                  projectId: typeof row.projectId === "string" ? row.projectId : null,
                },
              ];
            })
          );
        }
      }
    } catch {
      // A transient poll failure should never blank the navigation.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const deleteConversation = async (id: string, event: React.MouseEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm("Delete this conversation?")) return;

    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    setConversations((current) => current.filter((c) => c.id !== id));
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
            className="flex w-full items-center gap-2 rounded-[6px] border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
          >
            <span className="text-gray-400">+</span> New Chat
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
                className="rounded-[6px] p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
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
                      isActive ? "bg-gray-200 text-gray-900" : "hover:bg-gray-100"
                    }`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-gray-400" aria-hidden="true">
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
                      isActive ? "bg-gray-200 text-gray-900" : "hover:bg-gray-100"
                    }`}
                  >
                    <Link
                      href={`/chat/${conv.id}`}
                      className="flex-1 truncate px-2 py-[6px] text-[13px] font-medium transition-colors"
                    >
                      {conv.title || "New Conversation"}
                    </Link>
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
            </div>
          )}
        </div>

        <AccountMenu />
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(project) => {
          setProjects((current) => [{ id: project.id, name: project.name }, ...current]);
          router.push(`/projects/${project.id}`);
        }}
      />
    </>
  );
}
