"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Model selector for the chat header.
 *
 * Fetches the catalogue from `/api/models` once on mount and lets the user pick which
 * model answers the NEXT message. The choice applies to the next generation only —
 * messages already in the transcript keep whatever model produced them, so switching
 * never rewrites history.
 *
 * The control is a button + listbox pair (not a native <select>) because each row
 * carries a second line of provider and strength metadata. Focus stays on the trigger
 * while the panel is open and the active row is tracked with `aria-activedescendant`,
 * which keeps Escape/Tab handling in one place and avoids focus traps in the header.
 *
 * Failure is non-fatal: a broken or slow fetch degrades to a static label rather than
 * taking the chat header down with it.
 */

export interface ClientModelInfo {
  id: string;
  displayName: string;
  providerLabel: string;
  strengths: string[];
  supportsVision: boolean;
  available: boolean;
  comingSoon: boolean;
}

interface ModelsResponse {
  models: ClientModelInfo[];
  defaultModelId: string;
}

interface ModelSelectorProps {
  /** Currently selected model id, or null to fall back to the server default. */
  value: string | null;
  /** Fires when the user picks a model different from the current one. */
  onChange: (modelId: string) => void;
  /** True while a response is streaming — a model cannot be swapped mid-stream. */
  disabled?: boolean;
}

type LoadState = "loading" | "ready" | "error";

/** Narrow the untyped JSON body into the shape this component relies on. */
function parseModelsResponse(body: unknown): ModelsResponse | null {
  if (!body || typeof body !== "object") return null;

  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.models) || typeof raw.defaultModelId !== "string") return null;

  const models: ClientModelInfo[] = [];
  for (const entry of raw.models) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.displayName !== "string") continue;

    models.push({
      id: candidate.id,
      displayName: candidate.displayName,
      providerLabel: typeof candidate.providerLabel === "string" ? candidate.providerLabel : "",
      strengths: Array.isArray(candidate.strengths)
        ? candidate.strengths.filter((s): s is string => typeof s === "string")
        : [],
      supportsVision: candidate.supportsVision === true,
      available: candidate.available !== false,
      comingSoon: candidate.comingSoon === true,
    });
  }

  if (models.length === 0) return null;
  return { models, defaultModelId: raw.defaultModelId };
}

function describeModel(model: ClientModelInfo): string {
  return [model.providerLabel, ...model.strengths].filter(Boolean).join(" · ");
}

export function ModelSelector({ value, onChange, disabled }: ModelSelectorProps): React.ReactElement {
  const [models, setModels] = useState<ClientModelInfo[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  // --- Load the catalogue once -------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch("/api/models", { signal: controller.signal });
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);

        const parsed = parseModelsResponse(await res.json());
        if (!parsed) throw new Error("Malformed model list");
        if (cancelled) return;

        setModels(parsed.models);
        setDefaultModelId(parsed.defaultModelId);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const selectedId = value ?? defaultModelId;
  const selected = models.find((m) => m.id === selectedId) ?? null;
  const selectableIndexes = models.map((m, i) => (m.available ? i : -1)).filter((i) => i >= 0);

  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  // --- Outside click ------------------------------------------------------
  useEffect(() => {
    if (!open) return;

    const onMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // A model cannot be swapped mid-stream: collapse if streaming starts while open.
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setActiveIndex(-1);
    }
  }, [disabled]);

  const commit = useCallback(
    (model: ClientModelInfo) => {
      if (!model.available) return;
      // Re-picking the current model is a no-op beyond closing the panel.
      if (model.id !== selectedId) onChange(model.id);
      closeAndRefocus();
    },
    [closeAndRefocus, onChange, selectedId]
  );

  /** Open with the selected row active, or the first selectable one. */
  const openPanel = useCallback(
    (preferLast: boolean) => {
      if (disabled || selectableIndexes.length === 0) return;

      const current = models.findIndex((m) => m.id === selectedId && m.available);
      const fallback = preferLast
        ? selectableIndexes[selectableIndexes.length - 1]
        : selectableIndexes[0];

      setActiveIndex(current >= 0 ? current : fallback);
      setOpen(true);
    },
    [disabled, models, selectableIndexes, selectedId]
  );

  /** Step through selectable rows only; unavailable ones are skipped entirely. */
  const move = useCallback(
    (delta: number) => {
      if (selectableIndexes.length === 0) return;

      const position = selectableIndexes.indexOf(activeIndex);
      const next =
        position === -1
          ? selectableIndexes[delta > 0 ? 0 : selectableIndexes.length - 1]
          : selectableIndexes[
              (position + delta + selectableIndexes.length) % selectableIndexes.length
            ];

      setActiveIndex(next);
    },
    [activeIndex, selectableIndexes]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;

    if (event.key === "Tab") {
      // Let focus leave naturally, but never leave an orphaned panel behind.
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        openPanel(false);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        openPanel(true);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(selectableIndexes[0] ?? -1);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(selectableIndexes[selectableIndexes.length - 1] ?? -1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const model = models[activeIndex];
        if (model) commit(model);
        break;
      }
      case "Escape":
        event.preventDefault();
        closeAndRefocus();
        break;
      default:
        break;
    }
  };

  // --- Loading / failure fallbacks ---------------------------------------
  // Both reserve the same box as the real trigger so the header never jumps.
  if (state === "loading") {
    return (
      <div
        aria-hidden="true"
        className="h-[30px] w-[150px] shrink-0 animate-pulse rounded-lg border border-gray-200 bg-gray-100"
      />
    );
  }

  if (state === "error" || !selected) {
    return (
      <span className="inline-flex h-[30px] shrink-0 items-center rounded-lg border border-gray-200 bg-gray-50 px-2.5 text-[13px] font-medium text-gray-500">
        {selected?.displayName ?? "Default model"}
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closeAndRefocus() : openPanel(false))}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        aria-label={`Model for the next message: ${selected.displayName}`}
        title={disabled ? "Model can't be changed while generating" : "Choose the model for your next message"}
        className="flex h-[30px] max-w-[190px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white sm:max-w-none"
      >
        <span className="truncate">{selected.displayName}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Available models"
          // Anchored to the trigger's right edge and capped to the viewport: the app
          // sets overflow-x:hidden on body, so an overflowing panel would be clipped.
          className="absolute right-0 top-full z-20 mt-2 max-h-[60vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-dropdown"
        >
          {models.map((model, index) => {
            const isSelected = model.id === selectedId;
            const isActive = index === activeIndex;

            return (
              <div
                key={model.id}
                id={`${listboxId}-opt-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={!model.available}
                onMouseEnter={() => model.available && setActiveIndex(index)}
                onClick={() => commit(model)}
                className={`flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 ${
                  model.available
                    ? isActive
                      ? "bg-accent-50"
                      : "bg-transparent"
                    : "cursor-not-allowed opacity-50"
                }`}
              >
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-accent-600">
                  {isSelected && (
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
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>

                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-gray-900">
                      {model.displayName}
                    </span>
                    {!model.available && (
                      <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        {model.comingSoon ? "Coming soon" : "Unavailable"}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 truncate text-[11px] text-gray-500">
                    {describeModel(model)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
