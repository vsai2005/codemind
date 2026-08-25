"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard control with transient confirmation.
 *
 * The Clipboard API is unavailable on insecure origins other than localhost — which
 * includes reaching CodeMind over a LAN IP from a phone. A textarea + execCommand
 * fallback keeps copy working there rather than silently doing nothing.
 */

async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Keep it out of view and out of the tab order while still selectable.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

interface CopyButtonProps {
  /** Resolved lazily so a large message body is only read when actually copied. */
  getText: () => string;
  label?: string;
  className?: string;
}

export function CopyButton({
  getText,
  label = "Copy",
  className = "",
}: CopyButtonProps): React.ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await writeToClipboard(getText());
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  }, [getText]);

  const text = state === "copied" ? "Copied" : state === "failed" ? "Failed" : label;

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={state === "copied" ? "Copied to clipboard" : `${label} to clipboard`}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
        state === "copied" ? "text-emerald-600" : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
      } ${className}`}
    >
      {state === "copied" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {text}
    </button>
  );
}
