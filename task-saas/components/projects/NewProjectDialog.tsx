"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * "New project" dialog.
 *
 * Deliberately small: a name, an optional description, and one button. Instructions and
 * memory are edited afterwards in ProjectSettings, so nothing stands between the user
 * and a created project.
 *
 * The dialog owns a complete focus contract for as long as it is open — focus moves to
 * the name field, Tab cycles inside the panel, and closing hands focus back to whatever
 * was focused beforehand. A keyboard user therefore never wanders into the page behind
 * the backdrop, and never has to hunt for their place again after dismissing it.
 *
 * Closing also aborts any in-flight create. That is what guarantees `onCreated` can
 * never fire against a dialog the user has already dismissed — the alternative (letting
 * the request land) would surface a project the user believed they had cancelled.
 *
 * Client-side validation exists only as a fast path for typos. The route re-validates
 * everything and remains the authority, so a 400 shows the server's own `error` string
 * rather than a guess made here.
 */

interface NewProjectDialogProps {
  /** Renders nothing at all when false. */
  open: boolean;
  /** Called for every dismissal: Cancel, Escape, backdrop, and after a success. */
  onClose: () => void;
  /** Fires once, with the created project, immediately before `onClose`. */
  onCreated: (project: { id: string; name: string }) => void;
}

interface CreatedProject {
  id: string;
  name: string;
}

interface FieldErrors {
  name?: string;
  description?: string;
}

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Tabbable, currently-rendered descendants, in document order. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      el.tabIndex !== -1 &&
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
  );
}

/** Narrow `{ project: { id, name, ... } }` without trusting the body's shape. */
function parseCreatedProject(body: unknown): CreatedProject | null {
  if (!body || typeof body !== "object") return null;

  const project = (body as Record<string, unknown>).project;
  if (!project || typeof project !== "object") return null;

  const candidate = project as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;

  return { id: candidate.id, name: candidate.name };
}

/** Pull `{ error }` off a JSON body without trusting its shape. */
function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const candidate = (body as Record<string, unknown>).error;
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return fallback;
}

export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: NewProjectDialogProps): React.ReactElement | null {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A click only counts as "on the backdrop" when it also STARTED there; otherwise
  // selecting text inside the panel and releasing outside it would close the dialog.
  const backdropPressRef = useRef(false);

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const nameId = `${baseId}-name`;
  const descriptionId = `${baseId}-description`;
  const nameErrorId = `${nameId}-error`;
  const descriptionErrorId = `${descriptionId}-error`;
  const descriptionHintId = `${descriptionId}-hint`;

  const resetFields = useCallback(() => {
    setName("");
    setDescription("");
    setFieldErrors({});
    setFormError(null);
  }, []);

  /** Every dismissal path funnels through here so nothing outlives the dialog. */
  const requestClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSubmitting(false);
    onClose();
  }, [onClose]);

  // --- Focus: enter on open, restore on close ----------------------------
  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // A stale banner from a previous attempt must not greet the next one.
    setFormError(null);
    setFieldErrors({});

    const frame = window.requestAnimationFrame(() => nameInputRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  // --- Escape to dismiss, Tab trapped inside -----------------------------
  // Listening on the document (capture) rather than the panel keeps Escape working
  // even after a backdrop click has parked focus on <body>.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      // Re-queried on every press: the submit button leaves the tab order while the
      // request is in flight, so a cached list would send focus nowhere.
      const items = focusableWithin(dialog);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, requestClose]);

  // Abort a create that is still running if the dialog unmounts outright.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Returns the errors found; an empty object means the form may be submitted. */
  const validate = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();

    if (trimmedName.length === 0) {
      errors.name = "Please enter a project name.";
    } else if (trimmedName.length > MAX_NAME_LENGTH) {
      errors.name = `Project names are limited to ${MAX_NAME_LENGTH} characters.`;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.description = `Descriptions are limited to ${MAX_DESCRIPTION_LENGTH} characters.`;
    }

    return errors;
  }, [description, name]);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;

    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) {
      if (errors.name) nameInputRef.current?.focus();
      return;
    }

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const controller = new AbortController();
    abortRef.current = controller;
    setSubmitting(true);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          trimmedDescription.length > 0
            ? { name: trimmedName, description: trimmedDescription }
            : { name: trimmedName }
        ),
        signal: controller.signal,
      });

      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        setFormError(
          readErrorMessage(payload, "Could not create the project. Please try again.")
        );
        return;
      }

      const created = parseCreatedProject(payload);
      if (!created) {
        setFormError("The project may not have been created. Please refresh and check.");
        return;
      }

      resetFields();
      onCreated(created);
      onClose();
    } catch (error) {
      // An abort is a dismissal, not a failure — the dialog is already gone.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFormError("Something went wrong. Please try again.");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  if (!open) return null;

  const inputClass = (hasError: boolean): string =>
    `block w-full rounded-[6px] border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-gray-400 focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 ${
      hasError ? "border-red-300" : "border-gray-300"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-gray-900/40 p-4"
      onMouseDown={(event) => {
        backdropPressRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && backdropPressRef.current) requestClose();
        backdropPressRef.current = false;
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[calc(100vh-2rem)] w-full max-w-[26rem] overflow-y-auto rounded-xl border border-gray-200 bg-white p-5 shadow-lg sm:p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-900">
              New project
            </h2>
            <p className="mt-1 text-[13px] text-gray-500">
              Group related conversations, files, and instructions together.
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close dialog"
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
          >
            <svg
              width="16"
              height="16"
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
          </button>
        </div>

        {formError && (
          <div
            role="alert"
            className="mb-4 rounded-[6px] border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-900"
          >
            {formError}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={nameId} className="block text-sm font-medium text-gray-700">
              Project name
            </label>
            <input
              ref={nameInputRef}
              id={nameId}
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              placeholder="Billing service rewrite"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? nameErrorId : undefined}
              className={inputClass(Boolean(fieldErrors.name))}
            />
            {fieldErrors.name && (
              <p id={nameErrorId} className="text-xs text-red-600">
                {fieldErrors.name}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={descriptionId} className="block text-sm font-medium text-gray-700">
                Description
              </label>
              <span className="shrink-0 text-[11px] text-gray-400">Optional</span>
            </div>
            <textarea
              id={descriptionId}
              name="description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              placeholder="What this project is for."
              aria-invalid={fieldErrors.description ? true : undefined}
              aria-describedby={
                fieldErrors.description ? descriptionErrorId : descriptionHintId
              }
              className={`${inputClass(Boolean(fieldErrors.description))} resize-none leading-6`}
            />
            {fieldErrors.description ? (
              <p id={descriptionErrorId} className="text-xs text-red-600">
                {fieldErrors.description}
              </p>
            ) : (
              <p id={descriptionHintId} className="text-xs text-gray-400">
                {description.length > 0
                  ? `${description.length} of ${MAX_DESCRIPTION_LENGTH} characters.`
                  : "A short note about the project. You can change this later."}
              </p>
            )}
          </div>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={requestClose}
              className="inline-flex items-center justify-center rounded-[6px] border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 rounded-[6px] bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
              )}
              {submitting ? "Creating..." : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
