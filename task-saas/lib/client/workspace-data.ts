"use client";

/**
 * Shared client-side cache for the navigation data — the user's projects and their
 * conversations.
 *
 * Replaces two independent 5-second polls (the sidebar's, plus a duplicate project
 * fetch from the workspace switcher) with one store that every navigation component
 * reads through `useSyncExternalStore`. Three things changed as a result:
 *
 *   deduplication   concurrent callers share one in-flight request instead of racing
 *   event-driven    mutations call `invalidateWorkspace()`, so the sidebar updates
 *                   immediately rather than waiting out a poll interval
 *   cheap idling    the safety-net interval is a minute, and it pauses entirely while
 *                   the tab is hidden; a focus listener catches up on return
 *
 * The result is responsive where it was previously stale-for-5-seconds, and quiet
 * where it was previously issuing 24 queries a minute per open tab at idle.
 */

export interface WorkspaceProject {
  id: string;
  name: string;
}

export interface WorkspaceConversation {
  id: string;
  title: string | null;
  projectId: string | null;
}

export interface WorkspaceSnapshot {
  projects: WorkspaceProject[];
  conversations: WorkspaceConversation[];
  /** False until the first response lands, so the UI can tell empty from unknown. */
  loaded: boolean;
}

/** Server render and first paint both see this exact object. */
const EMPTY: WorkspaceSnapshot = { projects: [], conversations: [], loaded: false };

let snapshot: WorkspaceSnapshot = EMPTY;
const listeners = new Set<() => void>();

let inFlight: Promise<void> | null = null;
let lastCompletedAt = 0;

/** Collapses bursts — a mount, a focus and a mutation arriving together are one fetch. */
const DEDUPE_WINDOW_MS = 1_500;

/** Safety net for changes made in another tab or by another device. */
export const BACKGROUND_REFRESH_MS = 60_000;

function emit(): void {
  // Array.from so the iteration does not depend on downlevelIteration, and so a
  // listener unsubscribing during the callback cannot disturb the walk.
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeToWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  return snapshot;
}

/** Stable identity: `useSyncExternalStore` requires the server snapshot not to change. */
export function getWorkspaceServerSnapshot(): WorkspaceSnapshot {
  return EMPTY;
}

function toProjects(body: unknown): WorkspaceProject[] {
  const list = Array.isArray(body) ? body : (body as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): WorkspaceProject[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.name === "string"
      ? [{ id: row.id, name: row.name }]
      : [];
  });
}

function toConversations(body: unknown): WorkspaceConversation[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry): WorkspaceConversation[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string") return [];
    return [
      {
        id: row.id,
        title: typeof row.title === "string" ? row.title : null,
        projectId: typeof row.projectId === "string" ? row.projectId : null,
      },
    ];
  });
}

async function load(): Promise<void> {
  try {
    const [projectsRes, conversationsRes] = await Promise.all([
      fetch("/api/projects"),
      fetch("/api/conversations"),
    ]);

    const next: WorkspaceSnapshot = {
      projects: projectsRes.ok ? toProjects(await projectsRes.json()) : snapshot.projects,
      conversations: conversationsRes.ok
        ? toConversations(await conversationsRes.json())
        : snapshot.conversations,
      loaded: true,
    };

    snapshot = next;
  } catch {
    // A transient failure must never blank the navigation; keep the last good data and
    // only flip `loaded` so empty states can render instead of a permanent skeleton.
    snapshot = { ...snapshot, loaded: true };
  } finally {
    lastCompletedAt = Date.now();
    inFlight = null;
    emit();
  }
}

/**
 * Fetch the navigation data, reusing an in-flight request when one exists.
 *
 * `force` skips the dedupe window and is what mutations use — after deleting a
 * conversation the user must see it disappear, not wait out a debounce.
 */
export function refreshWorkspace(options: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;

  if (!options.force && Date.now() - lastCompletedAt < DEDUPE_WINDOW_MS) {
    return Promise.resolve();
  }

  inFlight = load();
  return inFlight;
}

/** Call after any mutation that changes what the navigation shows. */
export function invalidateWorkspace(): void {
  void refreshWorkspace({ force: true });
}

/**
 * Apply a local change immediately, before the server confirms it.
 *
 * Used for deletion, where waiting for a round trip makes the click feel broken. The
 * subsequent `invalidateWorkspace()` reconciles against the server.
 */
export function patchWorkspaceSnapshot(
  update: (current: WorkspaceSnapshot) => WorkspaceSnapshot
): void {
  snapshot = update(snapshot);
  emit();
}

/** Test-only: drop all cached state between cases. */
export function __resetWorkspaceData(): void {
  snapshot = EMPTY;
  inFlight = null;
  lastCompletedAt = 0;
  listeners.clear();
}
