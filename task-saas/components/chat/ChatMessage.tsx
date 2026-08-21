"use client";

import { Message } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { PlanPanel, parsePlan, type ChatPlan } from "./PlanPanel";

/**
 * Artifact rendering.
 *
 * Primary path: the server attaches artifact metadata to the assistant message as an
 * annotation, and this component renders a card from it. File contents never reach
 * the browser — only id, type, filename and size.
 *
 * Fallback path: conversations created before artifacts moved into their own table
 * still contain inline `<codemind_artifact>` markup. The regex parser below exists
 * solely to keep those old messages working and to strip stray markup from view. It
 * is not how artifacts are produced.
 */

interface ArtifactCardData {
  /** Present for stored artifacts; absent for legacy inline markup. */
  id?: string;
  type: string;
  filename: string;
  fileCount?: number;
  byteSize?: number;
}

const ATTACHMENT_TAG_RE = /<codemind_attachments>([\s\S]*?)<\/codemind_attachments>/;

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== "number" || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeArtifact(artifact: ArtifactCardData): string {
  const size = formatBytes(artifact.byteSize);
  const parts: string[] = [];

  if (artifact.type === "zip") {
    parts.push(
      artifact.fileCount && artifact.fileCount > 0
        ? `Complete project · ${artifact.fileCount} file${artifact.fileCount === 1 ? "" : "s"}`
        : "Complete project"
    );
  } else if (artifact.type === "pdf") {
    parts.push("PDF document");
  } else {
    parts.push("Source file");
  }

  if (size) parts.push(size);
  return parts.join(" · ");
}

function ArtifactIcon({ type }: { type: string }): React.ReactElement {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
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

/** Read artifact metadata the server attached to this message. */
function artifactsFromAnnotations(message: Message): ArtifactCardData[] {
  const annotations = message.annotations;
  if (!Array.isArray(annotations)) return [];

  const found: ArtifactCardData[] = [];
  for (const annotation of annotations) {
    if (
      annotation &&
      typeof annotation === "object" &&
      "codemindArtifacts" in annotation &&
      Array.isArray((annotation as Record<string, unknown>).codemindArtifacts)
    ) {
      for (const entry of (annotation as { codemindArtifacts: unknown[] }).codemindArtifacts) {
        if (entry && typeof entry === "object") {
          const candidate = entry as ArtifactCardData;
          if (typeof candidate.filename === "string" && typeof candidate.type === "string") {
            found.push(candidate);
          }
        }
      }
    }
  }
  return found;
}

/** Read the plan the server attached to this message, if any. */
function planFromAnnotations(message: Message): ChatPlan | null {
  const annotations = message.annotations;
  if (!Array.isArray(annotations)) return null;

  for (const annotation of annotations) {
    if (annotation && typeof annotation === "object" && "codemindPlan" in annotation) {
      const parsed = parsePlan((annotation as Record<string, unknown>).codemindPlan);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function ChatMessage({ message }: { message: Message }): React.ReactElement {
  const isUser = message.role === "user";
  const [exportingId, setExportingId] = useState<string | null>(null);

  if (isUser) {
    let cleanContent = message.content;
    let attachments: Array<{ id?: string; name?: string; type?: string; url?: string }> = [];

    const match = message.content.match(ATTACHMENT_TAG_RE);
    if (match) {
      try {
        const meta = JSON.parse(match[1]);
        attachments = meta.attachments || [];
        cleanContent = message.content.replace(ATTACHMENT_TAG_RE, "").trim();
      } catch {
        // Malformed metadata: show the message text as-is.
      }
    }

    return (
      <div className="flex w-full justify-end mb-6">
        <div className="flex flex-col items-end max-w-[85%]">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 justify-end">
              {attachments.map((att, i) => (
                <div
                  key={att.id || att.name || i}
                  className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-2 shadow-sm"
                >
                  {att.type === "image" && att.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={att.url} alt={att.name ?? "attachment"} className="w-10 h-10 object-cover rounded-md" />
                  ) : (
                    <div className="w-10 h-10 bg-gray-100 rounded-md flex items-center justify-center text-gray-500">
                      <ArtifactIcon type="file" />
                    </div>
                  )}
                  <div className="flex flex-col max-w-[120px]">
                    <span className="text-xs font-semibold text-gray-800 truncate">{att.name}</span>
                    <span className="text-[10px] text-gray-500 uppercase">{att.type}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="rounded-[12px] px-5 py-3.5 bg-gray-100 text-gray-900 border border-gray-200/60 shadow-sm">
            <div className="whitespace-pre-wrap text-[15px] leading-relaxed font-medium">
              {cleanContent}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleDownload = async (artifact: ArtifactCardData): Promise<void> => {
    const key = artifact.id ?? artifact.filename;
    setExportingId(key);

    try {
      const response = artifact.id
        ? await fetch(`/api/artifacts/${artifact.id}/download`)
        : await fetch(`/api/export/${artifact.type}`, {
            // Legacy artifacts are still rebuilt from message content.
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: message.id, filename: artifact.filename }),
          });

      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        alert(detail?.error ?? "Failed to download this artifact.");
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
      setExportingId(null);
    }
  };

  let cleanContent = message.content;

  // Defensive: unwrap a JSON envelope if the model wraps its reply in one.
  if (cleanContent.trim().startsWith("{") && cleanContent.includes('"role"')) {
    const contentMatch = cleanContent.match(/"content"\s*:\s*"([^]*?)"(?:,|}|\n|$)/);
    if (contentMatch) {
      try {
        cleanContent = JSON.parse(`{"content": "${contentMatch[1]}"}`).content;
      } catch {
        cleanContent = contentMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
    }
  }

  const plan = planFromAnnotations(message);
  const annotated = artifactsFromAnnotations(message);
  const legacyArtifacts: ArtifactCardData[] = [];

  // --- Fallback parser for pre-migration messages -------------------------
  const closedArtifactRe =
    /<codemind_artifact\s+type="([^"]+)"\s+name="([^"]+)"(?:\s*\/|>([\s\S]*?)<\/codemind_artifact>)/g;
  let legacyMatch: RegExpExecArray | null;
  while ((legacyMatch = closedArtifactRe.exec(cleanContent)) !== null) {
    legacyArtifacts.push({ type: legacyMatch[1], filename: legacyMatch[2] });
  }
  cleanContent = cleanContent.replace(closedArtifactRe, "").trim();

  // Strip any unterminated markup so a partial tag never renders as text.
  cleanContent = cleanContent
    .replace(/<codemind_artifact\s+type="[^"]+"\s+name="[^"]+"(?:\s*\/|>[\s\S]*)$/, "")
    .replace(/<codemind_[^>]*>[\s\S]*?<\/codemind_[^>]+>/g, "")
    .replace(/<codemind_[^>]*>[\s\S]*$/, "")
    .trim();

  // Stored artifacts win; legacy markup is only used when there are none.
  const artifacts = annotated.length > 0 ? annotated : legacyArtifacts;

  return (
    <div className="group relative mb-6 flex w-full justify-start">
      <div className="w-full max-w-full">
        <div className="group/header mb-2 flex items-center justify-between">
          <div className="font-bold text-[12px] text-gray-500 tracking-wide uppercase">CodeMind</div>
          {cleanContent.length > 0 && (
            // Subtle until hover/focus on desktop; always visible on touch, where
            // there is no hover to reveal it.
            <div className="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
              <CopyButton getText={() => cleanContent} label="Copy" />
            </div>
          )}
        </div>

        {plan && <PlanPanel plan={plan} />}

        {cleanContent.length > 0 && (
          <div
            className="prose prose-base max-w-none
            prose-p:leading-relaxed prose-p:text-[15px] prose-p:text-gray-800
            prose-headings:text-gray-900 prose-headings:font-semibold prose-headings:mt-6 prose-headings:mb-3
            prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline
            prose-code:text-blue-700 prose-code:bg-blue-50/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none prose-code:font-medium
            prose-pre:bg-gray-50 prose-pre:border prose-pre:border-gray-200 prose-pre:rounded-[8px] prose-pre:p-4 prose-pre:text-gray-800
            prose-table:border-collapse prose-table:w-full prose-table:border prose-table:border-gray-200 prose-table:rounded-lg
            prose-th:bg-gray-50 prose-th:p-3 prose-th:border prose-th:border-gray-200 prose-th:text-left prose-th:font-semibold
            prose-td:p-3 prose-td:border prose-td:border-gray-200
            prose-ul:list-disc prose-ol:list-decimal prose-li:my-1
            overflow-hidden mb-4"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Fenced blocks get their own header + copy action. Inline `code`
                // still uses the prose styling above.
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              }}
            >
              {cleanContent}
            </ReactMarkdown>
          </div>
        )}

        {artifacts.length > 0 && (
          <div className="flex flex-col gap-3 mt-4">
            {artifacts.map((artifact, i) => {
              const key = artifact.id ?? artifact.filename;
              const busy = exportingId === key;

              return (
                <div
                  key={`${key}-${i}`}
                  className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-4 shadow-sm w-full max-w-md"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="shrink-0 w-10 h-10 rounded-md bg-gray-50 border border-gray-200 flex items-center justify-center text-gray-600">
                      <ArtifactIcon type={artifact.type} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium text-gray-900 text-sm truncate">
                        {artifact.filename}
                      </span>
                      <span className="text-xs text-gray-500">{describeArtifact(artifact)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDownload(artifact)}
                    disabled={busy}
                    className="shrink-0 ml-3 flex items-center gap-1.5 text-[12px] font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors px-3 py-1.5 rounded-md disabled:opacity-50"
                  >
                    {busy ? (
                      <div className="w-3.5 h-3.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
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
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    )}
                    {busy ? "Downloading…" : "Download"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
