"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Project settings panel: name and description, standing instructions, memory, and the
 * destructive actions.
 *
 * Every section saves independently, against its own PATCH, with its own status line.
 * That is deliberate — one giant "Save" over four unrelated concerns makes a failed
 * request ambiguous ("which part didn't save?") and forces the whole panel into a
 * pending state for a one-word rename.
 *
 * `baseline` holds the last state the SERVER confirmed; the individual fields hold the
 * draft. Dirty state — and therefore whether a save button is enabled at all — is the
 * difference between the two, so a save button is never live for a no-op write. A
 * successful save re-syncs the baseline plus only the fields that were sent, which is
 * what keeps a rename from quietly discarding half-typed instructions in the section
 * below it.
 *
 * Requests are narrowed through `parseProjectResponse` rather than cast: the panel
 * renders whatever it receives, so a malformed body is reported as a failure instead of
 * being trusted into state. Every path out of a save sets a terminal status, which is
 * what guarantees the UI can never be left stuck on "Saving...".
 */

export interface MemorySection {
  title: string;
  items: string[];
}

export interface ProjectSettingsValue {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  memory: MemorySection[] | null;
  /** ISO timestamp when archived, or null while the project is active. */
  archivedAt: string | null;
}

interface ProjectSettingsProps {
  project: ProjectSettingsValue;
  /** Fires after every accepted write, with the server's copy of the project. */
  onUpdated: (project: ProjectSettingsValue) => void;
  /** Fires once the project has actually been deleted. */
  onDeleted: () => void;
}

/** Only the keys being changed are sent; anything omitted is left alone server-side. */
interface ProjectPatchBody {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  memory?: MemorySection[] | null;
  archived?: boolean;
}

type PatchResult =
  | { ok: true; project: ProjectSettingsValue }
  | { ok: false; error: string };

/** Editable mirror of MemorySection. The keys are React identity only — never sent. */
interface DraftItem {
  key: string;
  text: string;
}

interface DraftSection {
  key: string;
  title: string;
  items: DraftItem[];
}

type MemoryDraftResult =
  | { ok: true; sections: MemorySection[] }
  | { ok: false; error: string };

interface SaveState {
  kind: "idle" | "saving" | "saved" | "error";
  message?: string;
}

// Mirrors the Zod schema on the route. Checking here turns a raw validation string
// into a sentence about the field the user is actually looking at; the server stays
// the authority either way.
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_INSTRUCTIONS_LENGTH = 20000;
const MAX_SECTION_TITLE_LENGTH = 120;
const MAX_ITEM_LENGTH = 500;
const MAX_ITEMS_PER_SECTION = 50;
const MAX_SECTIONS = 20;
const SAVED_MESSAGE_MS = 2500;

let draftKeySeed = 0;

/** Row identity that survives edits, reordering, and removal of neighbours. */
function nextKey(prefix: string): string {
  draftKeySeed += 1;
  return `${prefix}-${draftKeySeed}`;
}

function toDraft(memory: MemorySection[] | null): DraftSection[] {
  return (memory ?? []).map((section) => ({
    key: nextKey("section"),
    title: section.title,
    items: section.items.map((text) => ({ key: nextKey("item"), text })),
  }));
}

/**
 * Draft rows -> the array the API stores. Blank items are dropped, and so is a section
 * that is entirely blank (the row someone added and then thought better of). A section
 * carrying items but no title is a genuine mistake and blocks the save instead.
 */
function collectMemory(sections: DraftSection[]): MemoryDraftResult {
  const collected: MemorySection[] = [];

  for (const section of sections) {
    const title = section.title.trim();
    const items = section.items
      .map((item) => item.text.trim())
      .filter((text) => text.length > 0);

    if (title.length === 0) {
      if (items.length > 0) {
        return { ok: false, error: "Give every section a title before saving." };
      }
      continue;
    }
    if (title.length > MAX_SECTION_TITLE_LENGTH) {
      return {
        ok: false,
        error: `Section titles are limited to ${MAX_SECTION_TITLE_LENGTH} characters.`,
      };
    }
    if (items.some((text) => text.length > MAX_ITEM_LENGTH)) {
      return {
        ok: false,
        error: `Memory items are limited to ${MAX_ITEM_LENGTH} characters. Split the long one in two.`,
      };
    }
    if (items.length > MAX_ITEMS_PER_SECTION) {
      return {
        ok: false,
        error: `A section can hold up to ${MAX_ITEMS_PER_SECTION} items.`,
      };
    }

    collected.push({ title, items });
  }

  if (collected.length > MAX_SECTIONS) {
    return { ok: false, error: `A project can hold up to ${MAX_SECTIONS} memory sections.` };
  }

  return { ok: true, sections: collected };
}

/** Stable string form for dirty comparison; null and [] mean the same thing. */
function serializeMemory(memory: MemorySection[] | null): string {
  return JSON.stringify((memory ?? []).map((s) => ({ title: s.title, items: s.items })));
}

function parseMemory(value: unknown): MemorySection[] | null {
  if (!Array.isArray(value)) return null;

  const sections: MemorySection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.title !== "string") continue;

    sections.push({
      title: candidate.title,
      items: Array.isArray(candidate.items)
        ? candidate.items.filter((item): item is string => typeof item === "string")
        : [],
    });
  }
  return sections;
}

/** Narrow `{ project: {...} }` into the shape this panel renders. No casts. */
function parseProjectResponse(body: unknown): ProjectSettingsValue | null {
  if (!body || typeof body !== "object") return null;

  const project = (body as Record<string, unknown>).project;
  if (!project || typeof project !== "object") return null;

  const candidate = project as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;

  return {
    id: candidate.id,
    name: candidate.name,
    description: typeof candidate.description === "string" ? candidate.description : null,
    instructions: typeof candidate.instructions === "string" ? candidate.instructions : null,
    memory: parseMemory(candidate.memory),
    archivedAt: typeof candidate.archivedAt === "string" ? candidate.archivedAt : null,
  };
}

function parseDeleteResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as Record<string, unknown>).success === true;
}

/** Pull `{ error }` off a JSON body without trusting its shape. */
function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const candidate = (body as Record<string, unknown>).error;
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return fallback;
}

/** A "Saved" confirmation that clears itself. Errors stay until the next attempt. */
function useSaveState(): [SaveState, (next: SaveState) => void] {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const timerRef = useRef<number | null>(null);

  const update = useCallback((next: SaveState) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState(next);
    if (next.kind === "saved") {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setState({ kind: "idle" });
      }, SAVED_MESSAGE_MS);
    }
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return [state, update];
}

const INPUT_CLASS =
  "block w-full min-w-0 rounded-[6px] border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-gray-400 focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500";

const TEXT_BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded text-[13px] font-medium text-gray-600 transition-colors hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function SaveButton({
  label,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-[6px] bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-elevated transition-colors hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {pending && (
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
        />
      )}
      {pending ? "Saving..." : label}
    </button>
  );
}

/** Always mounted so assistive tech announces the change rather than the insertion. */
function StatusLine({ state }: { state: SaveState }): React.ReactElement {
  const isError = state.kind === "error";
  const message = isError || state.kind === "saved" ? state.message ?? "" : "";

  return (
    <p
      role="status"
      aria-live="polite"
      className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${
        isError ? "text-red-600" : "text-gray-500"
      }`}
    >
      {state.kind === "saved" && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span className="break-words">{message}</span>
    </p>
  );
}

function RemoveIcon(): React.ReactElement {
  return (
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function ProjectSettings({
  project,
  onUpdated,
  onDeleted,
}: ProjectSettingsProps): React.ReactElement {
  const [baseline, setBaseline] = useState<ProjectSettingsValue>(project);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  const [sections, setSections] = useState<DraftSection[]>(() => toDraft(project.memory));
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const [generalState, setGeneralState] = useSaveState();
  const [instructionsState, setInstructionsState] = useSaveState();
  const [memoryState, setMemoryState] = useSaveState();
  const [archiveState, setArchiveState] = useSaveState();
  const [deleteState, setDeleteState] = useSaveState();

  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  // Id of the field a freshly added row should hand focus to, consumed once.
  const pendingFocusRef = useRef<string | null>(null);

  const baseId = useId();
  const nameId = `${baseId}-name`;
  const descriptionId = `${baseId}-description`;
  const descriptionHintId = `${descriptionId}-hint`;
  const instructionsId = `${baseId}-instructions`;
  const instructionsHintId = `${instructionsId}-hint`;
  const memoryHintId = `${baseId}-memory-hint`;
  const archiveHintId = `${baseId}-archive-hint`;
  const deleteConfirmId = `${baseId}-delete-confirm`;
  const deleteHintId = `${baseId}-delete-hint`;
  const generalHeadingId = `${baseId}-general-heading`;
  const instructionsHeadingId = `${baseId}-instructions-heading`;
  const memoryHeadingId = `${baseId}-memory-heading`;
  const dangerHeadingId = `${baseId}-danger-heading`;

  const sectionTitleId = (sectionKey: string): string => `${baseId}-title-${sectionKey}`;
  const itemInputId = (itemKey: string): string => `${baseId}-item-${itemKey}`;

  // --- A different project in the same panel: drop every local draft -----
  useEffect(() => {
    if (project.id === baseline.id) return;

    setBaseline(project);
    setName(project.name);
    setDescription(project.description ?? "");
    setInstructions(project.instructions ?? "");
    setSections(toDraft(project.memory));
    setDeleteConfirm("");
    setGeneralState({ kind: "idle" });
    setInstructionsState({ kind: "idle" });
    setMemoryState({ kind: "idle" });
    setArchiveState({ kind: "idle" });
    setDeleteState({ kind: "idle" });
  }, [
    project,
    baseline.id,
    setArchiveState,
    setDeleteState,
    setGeneralState,
    setInstructionsState,
    setMemoryState,
  ]);

  // --- Auto-growing instructions textarea (same technique as Composer) ---
  // Collapsing to "auto" first is required: otherwise scrollHeight reports the previous
  // height and the box can only ever grow. The cap lives in the max-h-* class so it
  // stays responsive; this reads the computed value and clamps to it.
  const resizeInstructions = useCallback(() => {
    const el = instructionsRef.current;
    if (!el) return;

    el.style.height = "auto";

    const parsedMax = Number.parseFloat(window.getComputedStyle(el).maxHeight);
    const max = Number.isFinite(parsedMax) ? parsedMax : Number.POSITIVE_INFINITY;
    const needed = el.scrollHeight;

    el.style.height = `${Math.min(needed, max)}px`;
    el.style.overflowY = needed > max ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeInstructions();
  }, [instructions, resizeInstructions]);

  useEffect(() => {
    window.addEventListener("resize", resizeInstructions);
    return () => window.removeEventListener("resize", resizeInstructions);
  }, [resizeInstructions]);

  // A new memory row is useless without the caret in it.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    document.getElementById(target)?.focus();
  });

  const requestPatch = useCallback(
    async (body: ProjectPatchBody): Promise<PatchResult> => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const payload: unknown = await res.json().catch(() => null);

        if (!res.ok) {
          return {
            ok: false,
            error: readErrorMessage(payload, "Could not save your changes. Please try again."),
          };
        }

        const parsed = parseProjectResponse(payload);
        if (!parsed) {
          return { ok: false, error: "The server returned an unexpected response." };
        }

        return { ok: true, project: parsed };
      } catch {
        return { ok: false, error: "Network error — your changes were not saved." };
      }
    },
    [project.id]
  );

  // --- General -----------------------------------------------------------
  const generalDirty =
    name !== baseline.name || description !== (baseline.description ?? "");

  const onSaveGeneral = async (): Promise<void> => {
    if (generalState.kind === "saving") return;

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setGeneralState({ kind: "error", message: "Please enter a project name." });
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      setGeneralState({
        kind: "error",
        message: `Project names are limited to ${MAX_NAME_LENGTH} characters.`,
      });
      return;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      setGeneralState({
        kind: "error",
        message: `Descriptions are limited to ${MAX_DESCRIPTION_LENGTH} characters.`,
      });
      return;
    }

    setGeneralState({ kind: "saving" });

    const trimmedDescription = description.trim();
    const result = await requestPatch({
      name: trimmedName,
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
    });

    if (!result.ok) {
      setGeneralState({ kind: "error", message: result.error });
      return;
    }

    setBaseline(result.project);
    setName(result.project.name);
    setDescription(result.project.description ?? "");
    onUpdated(result.project);
    setGeneralState({ kind: "saved", message: "Saved" });
  };

  // --- Instructions ------------------------------------------------------
  const instructionsDirty = instructions !== (baseline.instructions ?? "");

  const onSaveInstructions = async (): Promise<void> => {
    if (instructionsState.kind === "saving") return;

    const trimmed = instructions.trim();
    if (trimmed.length > MAX_INSTRUCTIONS_LENGTH) {
      setInstructionsState({
        kind: "error",
        message: `Instructions are limited to ${MAX_INSTRUCTIONS_LENGTH.toLocaleString()} characters.`,
      });
      return;
    }

    setInstructionsState({ kind: "saving" });

    const result = await requestPatch({ instructions: trimmed.length > 0 ? trimmed : null });

    if (!result.ok) {
      setInstructionsState({ kind: "error", message: result.error });
      return;
    }

    setBaseline(result.project);
    setInstructions(result.project.instructions ?? "");
    onUpdated(result.project);
    setInstructionsState({ kind: "saved", message: "Saved" });
  };

  // --- Memory ------------------------------------------------------------
  const collected = collectMemory(sections);
  const memoryDirty = collected.ok
    ? serializeMemory(collected.sections.length > 0 ? collected.sections : null) !==
      serializeMemory(baseline.memory)
    : true;

  const addSection = (): void => {
    const key = nextKey("section");
    pendingFocusRef.current = sectionTitleId(key);
    setSections((prev) => [
      ...prev,
      { key, title: "", items: [{ key: nextKey("item"), text: "" }] },
    ]);
  };

  const removeSection = (sectionKey: string): void => {
    setSections((prev) => prev.filter((section) => section.key !== sectionKey));
  };

  const setSectionTitle = (sectionKey: string, title: string): void => {
    setSections((prev) =>
      prev.map((section) => (section.key === sectionKey ? { ...section, title } : section))
    );
  };

  const addItem = (sectionKey: string): void => {
    const key = nextKey("item");
    pendingFocusRef.current = itemInputId(key);
    setSections((prev) =>
      prev.map((section) =>
        section.key === sectionKey
          ? { ...section, items: [...section.items, { key, text: "" }] }
          : section
      )
    );
  };

  const setItemText = (sectionKey: string, itemKey: string, text: string): void => {
    setSections((prev) =>
      prev.map((section) =>
        section.key === sectionKey
          ? {
              ...section,
              items: section.items.map((item) =>
                item.key === itemKey ? { ...item, text } : item
              ),
            }
          : section
      )
    );
  };

  const removeItem = (sectionKey: string, itemKey: string): void => {
    setSections((prev) =>
      prev.map((section) =>
        section.key === sectionKey
          ? { ...section, items: section.items.filter((item) => item.key !== itemKey) }
          : section
      )
    );
  };

  const onSaveMemory = async (): Promise<void> => {
    if (memoryState.kind === "saving") return;

    const draft = collectMemory(sections);
    if (!draft.ok) {
      setMemoryState({ kind: "error", message: draft.error });
      return;
    }

    setMemoryState({ kind: "saving" });

    // The full array replaces whatever is stored; no sections at all means null.
    const result = await requestPatch({
      memory: draft.sections.length > 0 ? draft.sections : null,
    });

    if (!result.ok) {
      setMemoryState({ kind: "error", message: result.error });
      return;
    }

    setBaseline(result.project);
    setSections(toDraft(result.project.memory));
    onUpdated(result.project);
    setMemoryState({ kind: "saved", message: "Saved" });
  };

  // --- Danger zone -------------------------------------------------------
  const archived = baseline.archivedAt !== null;

  const onToggleArchive = async (): Promise<void> => {
    if (archiveState.kind === "saving") return;

    setArchiveState({ kind: "saving" });
    const result = await requestPatch({ archived: !archived });

    if (!result.ok) {
      setArchiveState({ kind: "error", message: result.error });
      return;
    }

    setBaseline(result.project);
    onUpdated(result.project);
    setArchiveState({
      kind: "saved",
      message: result.project.archivedAt ? "Project archived" : "Project restored",
    });
  };

  const deleteArmed = deleteConfirm.trim() === baseline.name;

  const onDelete = async (): Promise<void> => {
    if (deleteState.kind === "saving" || !deleteArmed) return;

    setDeleteState({ kind: "saving" });

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
      });
      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        setDeleteState({
          kind: "error",
          message: readErrorMessage(payload, "Could not delete the project. Please try again."),
        });
        return;
      }
      if (!parseDeleteResponse(payload)) {
        setDeleteState({
          kind: "error",
          message: "The project may not have been deleted. Please refresh and check.",
        });
        return;
      }

      setDeleteState({ kind: "idle" });
      onDeleted();
    } catch {
      setDeleteState({ kind: "error", message: "Network error — the project was not deleted." });
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-10">
      {/* --- General --------------------------------------------------- */}
      <section aria-labelledby={generalHeadingId} className="space-y-4">
        <h2 id={generalHeadingId} className="text-sm font-semibold text-gray-900">
          General
        </h2>

        <div className="space-y-1.5">
          <label htmlFor={nameId} className="block text-sm font-medium text-gray-700">
            Project name
          </label>
          <input
            id={nameId}
            type="text"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={generalState.kind === "saving"}
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={descriptionId} className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            id={descriptionId}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={generalState.kind === "saving"}
            aria-describedby={descriptionHintId}
            placeholder="What this project is for."
            className={`${INPUT_CLASS} resize-none leading-6`}
          />
          <p id={descriptionHintId} className="text-xs text-gray-400">
            Shown alongside the project. Not sent to the model.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SaveButton
            label="Save changes"
            pending={generalState.kind === "saving"}
            disabled={!generalDirty}
            onClick={() => void onSaveGeneral()}
          />
          <StatusLine state={generalState} />
        </div>
      </section>

      {/* --- Project instructions -------------------------------------- */}
      <section aria-labelledby={instructionsHeadingId} className="space-y-3">
        <div className="space-y-1">
          <h2 id={instructionsHeadingId} className="text-sm font-semibold text-gray-900">
            Project instructions
          </h2>
          <p id={instructionsHintId} className="text-[13px] leading-relaxed text-gray-500">
            These apply to every conversation in this project, on top of anything you say in
            the chat itself. Use them for standing preferences — &ldquo;Use TypeScript&rdquo;,
            &ldquo;Use Tailwind CSS&rdquo;, &ldquo;Prefer server components&rdquo;,
            &ldquo;Explain trade-offs before writing code&rdquo;.
          </p>
        </div>

        <label htmlFor={instructionsId} className="sr-only">
          Project instructions
        </label>
        <textarea
          ref={instructionsRef}
          id={instructionsId}
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          disabled={instructionsState.kind === "saving"}
          aria-describedby={instructionsHintId}
          placeholder="Use TypeScript. Use Tailwind CSS. Keep comments short."
          className={`${INPUT_CLASS} max-h-[320px] min-h-[96px] resize-none break-words leading-6`}
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SaveButton
            label="Save instructions"
            pending={instructionsState.kind === "saving"}
            disabled={!instructionsDirty}
            onClick={() => void onSaveInstructions()}
          />
          <StatusLine state={instructionsState} />
        </div>
      </section>

      {/* --- Project memory -------------------------------------------- */}
      <section aria-labelledby={memoryHeadingId} className="space-y-3">
        <div className="space-y-1">
          <h2 id={memoryHeadingId} className="text-sm font-semibold text-gray-900">
            Project memory
          </h2>
          <p id={memoryHintId} className="text-[13px] leading-relaxed text-gray-500">
            Facts worth carrying between conversations, grouped into sections —
            &ldquo;Stack&rdquo;, &ldquo;Conventions&rdquo;, &ldquo;Decisions&rdquo;. Keep each
            item to a single line.
          </p>
        </div>

        {sections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center">
            <p className="text-[13px] text-gray-500">
              No memory yet. Add a section to start collecting what CodeMind should remember.
            </p>
            <button
              type="button"
              onClick={addSection}
              className={`${TEXT_BUTTON_CLASS} mt-3 text-gray-900`}
            >
              + Add section
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {sections.map((section, sectionIndex) => {
              const label = section.title.trim() || `section ${sectionIndex + 1}`;

              return (
                <div
                  key={section.key}
                  className="space-y-2.5 rounded-lg border border-gray-200 bg-white p-3 sm:p-4"
                >
                  <div className="flex items-center gap-2">
                    <label htmlFor={sectionTitleId(section.key)} className="sr-only">
                      Section title
                    </label>
                    <input
                      id={sectionTitleId(section.key)}
                      type="text"
                      value={section.title}
                      onChange={(e) => setSectionTitle(section.key, e.target.value)}
                      placeholder="Section title"
                      className={`${INPUT_CLASS} flex-1 font-medium`}
                    />
                    <button
                      type="button"
                      onClick={() => removeSection(section.key)}
                      aria-label={`Remove ${label}`}
                      title="Remove section"
                      className="shrink-0 rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    >
                      <RemoveIcon />
                    </button>
                  </div>

                  {section.items.length > 0 && (
                    <ul className="space-y-2">
                      {section.items.map((item, itemIndex) => (
                        <li key={item.key} className="flex items-center gap-2">
                          <label htmlFor={itemInputId(item.key)} className="sr-only">
                            {`Item ${itemIndex + 1} in ${label}`}
                          </label>
                          <input
                            id={itemInputId(item.key)}
                            type="text"
                            value={item.text}
                            onChange={(e) => setItemText(section.key, item.key, e.target.value)}
                            placeholder="Something to remember"
                            className={`${INPUT_CLASS} flex-1 text-[13px]`}
                          />
                          <button
                            type="button"
                            onClick={() => removeItem(section.key, item.key)}
                            aria-label={`Remove item ${itemIndex + 1} from ${label}`}
                            title="Remove item"
                            className="shrink-0 rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                          >
                            <RemoveIcon />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <button
                    type="button"
                    onClick={() => addItem(section.key)}
                    disabled={section.items.length >= MAX_ITEMS_PER_SECTION}
                    className={TEXT_BUTTON_CLASS}
                  >
                    + Add item
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addSection}
              disabled={sections.length >= MAX_SECTIONS}
              className={TEXT_BUTTON_CLASS}
            >
              + Add section
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          <SaveButton
            label="Save memory"
            pending={memoryState.kind === "saving"}
            disabled={!memoryDirty}
            onClick={() => void onSaveMemory()}
          />
          <StatusLine state={memoryState} />
        </div>
      </section>

      {/* --- Danger zone ------------------------------------------------ */}
      <section
        aria-labelledby={dangerHeadingId}
        className="space-y-6 border-t border-gray-200 pt-8"
      >
        <h2 id={dangerHeadingId} className="text-sm font-semibold text-gray-900">
          Danger zone
        </h2>

        <div className="space-y-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-gray-900">
                {archived ? "Unarchive project" : "Archive project"}
              </p>
              <p id={archiveHintId} className="text-[13px] leading-relaxed text-gray-500">
                {archived
                  ? "Bring this project back into the sidebar. Nothing was removed while it was archived."
                  : "Hides the project from the sidebar. Every conversation, file, instruction, and memory stays exactly as it is, and you can unarchive at any time."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onToggleArchive()}
              disabled={archiveState.kind === "saving"}
              aria-describedby={archiveHintId}
              className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-[6px] border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {archiveState.kind === "saving" && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
                />
              )}
              {archived ? "Unarchive" : "Archive"}
            </button>
          </div>
          <StatusLine state={archiveState} />
        </div>

        <div className="space-y-3 border-t border-gray-200 pt-6">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-gray-900">Delete project</p>
            <p id={deleteHintId} className="text-[13px] leading-relaxed text-gray-500">
              Deletes the project along with its instructions and memory. This cannot be
              undone. Conversations in this project are <strong>not</strong> deleted — they
              lose their project and become personal chats you can still find in the sidebar.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={deleteConfirmId} className="block text-sm font-medium text-gray-700">
              Type <span className="font-semibold text-gray-900">{baseline.name}</span> to
              confirm
            </label>
            <input
              id={deleteConfirmId}
              type="text"
              autoComplete="off"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              disabled={deleteState.kind === "saving"}
              aria-describedby={deleteHintId}
              className={`${INPUT_CLASS} sm:max-w-sm`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={!deleteArmed || deleteState.kind === "saving"}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-[6px] border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-white"
            >
              {deleteState.kind === "saving" && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-red-200 border-t-red-600"
                />
              )}
              {deleteState.kind === "saving" ? "Deleting..." : "Delete project"}
            </button>
            <StatusLine state={deleteState} />
          </div>
        </div>
      </section>
    </div>
  );
}
