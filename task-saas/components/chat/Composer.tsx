"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatError } from "./ChatError";

/**
 * Chat composer.
 *
 * The textarea auto-grows with its content and stops at a responsive maximum, after
 * which it scrolls internally. Height is driven from `scrollHeight` on every value
 * change (which covers typing, pasting, and programmatic clears alike) — there is no
 * polling and no fixed height.
 *
 * The maximum lives in CSS (`max-h-*` utilities) rather than JavaScript, so the
 * breakpoint stays responsive; the resize handler reads the computed value and clamps
 * to it. The composer sits in a `shrink-0` row beside a `flex-1` scroll area, so
 * growth steals height from the history pane and never extends the page.
 */

interface Attachment {
  id: string;
  name?: string;
  type?: string;
  url?: string;
  extractedText?: string;
}

interface ComposerProps {
  input: string;
  handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  append: (message: { role: "user"; content: string }) => void;
  /** Cancels the in-flight generation. Swaps Send for Stop while streaming. */
  stop?: () => void;
}

/** Clearing the input programmatically reuses the change handler useChat provides. */
function syntheticChange(value: string): React.ChangeEvent<HTMLTextAreaElement> {
  return { target: { value } } as unknown as React.ChangeEvent<HTMLTextAreaElement>;
}

export function Composer({
  input,
  handleInputChange,
  handleSubmit,
  isLoading,
  append,
  stop,
}: ComposerProps): React.ReactElement {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  /**
   * The most recent upload failure, and the file it was for.
   *
   * `alert()` used to swallow the real reason regardless of cause — a 10MB image and a
   * PDF that timed out both surfaced as the same "Failed to upload file", the same
   * class of silent failure fixed server-side in loadRepositoryFiles. `failedUploadFile`
   * exists so "Retry" can re-attempt the SAME upload rather than only reopening the
   * picker, matching what "Retry" already means on the chat-send banner.
   */
  const [uploadError, setUploadError] = useState<Error | null>(null);
  const [failedUploadFile, setFailedUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !isLoading && !uploading;

  /**
   * Measure and clamp. Collapsing to "auto" first is required: otherwise scrollHeight
   * reports the previous height and the box can only ever grow.
   */
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";

    const parsedMax = Number.parseFloat(window.getComputedStyle(el).maxHeight);
    const max = Number.isFinite(parsedMax) ? parsedMax : Number.POSITIVE_INFINITY;
    const needed = el.scrollHeight;

    el.style.height = `${Math.min(needed, max)}px`;
    // Only show a scrollbar once the content genuinely exceeds the cap.
    el.style.overflowY = needed > max ? "auto" : "hidden";
  }, []);

  // Runs for typing, paste, and the reset after a send.
  useLayoutEffect(() => {
    resize();
  }, [input, resize]);

  // The cap is breakpoint-dependent, so re-clamp when the viewport changes.
  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  /**
   * Upload one file, sharing the same success/failure handling for a fresh selection
   * and a retry so the two paths cannot drift apart.
   */
  const uploadFile = useCallback(async (file: File): Promise<void> => {
    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (res.ok) {
        const data = await res.json();
        setAttachments((prev) => [...prev, { ...data, id: Math.random().toString() }]);
        setFailedUploadFile(null);
      } else {
        // The upload route always answers a failure as {"error": "..."} JSON, the same
        // shape the chat route uses. Passed through unparsed so describeChatError —
        // already written to pull a human sentence out of exactly this shape — handles
        // it, rather than a second parser that could read the same body differently.
        const text = await res.text();
        setUploadError(new Error(text));
        setFailedUploadFile(file);
      }
    } catch {
      setUploadError(new Error("Could not reach the server. Check your connection and try again."));
      setFailedUploadFile(file);
    } finally {
      setUploading(false);
    }
  }, []);

  const onFileSelect = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    // Reset immediately, not in `finally`: the browser will not fire onChange again for
    // an identical File selection while the input still holds it, which would silently
    // block re-choosing the same file after a failure.
    if (fileInputRef.current) fileInputRef.current.value = "";
    await uploadFile(file);
  };

  const retryUpload = useCallback((): void => {
    if (failedUploadFile) void uploadFile(failedUploadFile);
  }, [failedUploadFile, uploadFile]);

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!input.trim() && attachments.length === 0) return;
    if (isLoading || uploading) return;

    if (attachments.length > 0) {
      const meta = JSON.stringify({ attachments });
      append({
        role: "user",
        content: `${input}\n\n<codemind_attachments>${meta}</codemind_attachments>`,
      });
      handleInputChange(syntheticChange(""));
      setAttachments([]);
    } else {
      handleSubmit(e);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      {uploadError && (
        <div className="mb-2">
          <ChatError
            error={uploadError}
            onRetry={retryUpload}
            disabled={uploading}
            hint="The file was not attached. Retry, or choose a different one."
          />
        </div>
      )}

      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="flex flex-col overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm transition-colors focus-within:border-gray-400"
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-gray-100 p-3">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="group relative flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 pr-8"
              >
                {att.type === "image" && att.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={att.url}
                    alt={att.name ?? "attachment"}
                    className="h-8 w-8 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-200 text-gray-500">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                      <polyline points="13 2 13 9 20 9" />
                    </svg>
                  </div>
                )}
                <span className="max-w-[150px] truncate text-xs font-semibold text-gray-800">
                  {att.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  aria-label={`Remove ${att.name ?? "attachment"}`}
                  className="absolute right-2 rounded text-gray-400 transition-colors hover:text-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Text area. Height is managed imperatively; the cap comes from max-h-* below. */}
        <div className="px-3.5 pt-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            rows={1}
            aria-label="Message CodeMind"
            placeholder="Message CodeMind..."
            className="block max-h-[220px] min-h-[24px] w-full resize-none break-words bg-transparent text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400 sm:max-h-[300px]"
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter inserts a newline (unchanged).
              // isComposing guard keeps IME candidate selection from submitting.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) formRef.current?.requestSubmit();
              }
            }}
          />
        </div>

        {/* Action row: stays below the textarea and moves down as it grows. */}
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1.5">
          <input
            type="file"
            ref={fileInputRef}
            onChange={onFileSelect}
            className="hidden"
            tabIndex={-1}
            accept="image/png,image/jpeg,image/webp,application/pdf,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Attach file"
            title="Attach file"
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50"
          >
            {uploading ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            )}
          </button>

          {isLoading && stop ? (
            // While streaming the primary action is cancellation. type="button" so it
            // can never submit the form by accident.
            <button
              type="button"
              onClick={stop}
              aria-label="Stop generating"
              title="Stop generating"
              className="rounded-card bg-accent-600 p-2 text-white shadow-elevated transition-colors hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
              className="rounded-card bg-accent-600 p-2 text-white shadow-elevated transition-colors hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>
      </form>

      <div className="mt-3 text-center text-[12px] font-medium text-gray-500">
        CodeMind can make mistakes. Consider verifying critical engineering information.
      </div>
    </div>
  );
}
