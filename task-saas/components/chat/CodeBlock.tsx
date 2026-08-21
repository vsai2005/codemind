"use client";

import { useCallback } from "react";
import { CopyButton } from "./CopyButton";

/**
 * Fenced code block with a language header and a copy action.
 *
 * Replaces ReactMarkdown's default <pre>. The copy action yields ONLY the source —
 * never the language label or any surrounding chrome — which is the whole point of
 * having it here rather than relying on a text selection.
 */

/** Recover the raw source from the React children ReactMarkdown hands us. */
function extractText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");

  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: React.ReactNode } }).props;
    return extractText(props?.children);
  }
  return "";
}

/** ReactMarkdown puts the fence language in a `language-xxx` class on the <code>. */
function languageFrom(node: React.ReactNode): string | null {
  if (typeof node !== "object" || node === null || !("props" in node)) return null;
  const className = (node as { props?: { className?: unknown } }).props?.className;
  if (typeof className !== "string") return null;
  const match = /language-([\w+#-]+)/.exec(className);
  return match ? match[1] : null;
}

export function CodeBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  const language = languageFrom(Array.isArray(children) ? children[0] : children);
  const getText = useCallback(() => extractText(children).replace(/\n$/, ""), [children]);

  return (
    <div className="my-4 overflow-hidden rounded-[8px] border border-gray-200 bg-gray-50">
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100/70 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
          {language ?? "code"}
        </span>
        <CopyButton getText={getText} />
      </div>
      {/* Wide code scrolls inside its own container so the page never scrolls sideways. */}
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-gray-800">
        {children}
      </pre>
    </div>
  );
}
