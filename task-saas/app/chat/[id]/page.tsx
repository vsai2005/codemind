"use client";

import { useChat } from "ai/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { ChatError } from "@/components/chat/ChatError";
import { ProjectSwitcher } from "@/components/projects/ProjectSwitcher";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Message, type JSONValue } from "ai";

interface StoredArtifact {
  id: string;
  type: string;
  filename: string;
  fileCount: number;
  byteSize: number;
}

interface StoredMessage {
  id: string;
  role: Message["role"];
  content: string;
  createdAt?: string;
  artifacts?: StoredArtifact[];
  plan?: unknown;
}

/**
 * Rehydrate a persisted message. Artifacts are re-attached as the same annotation
 * the live stream produces, so ChatMessage renders reloaded conversations and
 * in-flight ones through one code path.
 */
function toMessage(stored: StoredMessage): Message {
  const base: Message = {
    id: stored.id,
    role: stored.role,
    content: stored.content,
    ...(stored.createdAt ? { createdAt: new Date(stored.createdAt) } : {}),
  };

  // Plans and artifacts are re-attached as the same annotations the live stream
  // emits, so ChatMessage renders reloaded and in-flight conversations identically.
  const annotations: JSONValue[] = [];
  if (stored.plan) annotations.push({ codemindPlan: stored.plan } as unknown as JSONValue);
  if (stored.artifacts && stored.artifacts.length > 0) {
    annotations.push({ codemindArtifacts: stored.artifacts } as unknown as JSONValue);
  }

  return annotations.length > 0 ? { ...base, annotations } : base;
}

export default function ChatPage() {
  const params = useParams();
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  // Applies to the NEXT generation. Null means "use the server default".
  const [modelId, setModelId] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/conversations/${params.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.projectId === "string") setProjectId(data.projectId);
        if (Array.isArray(data?.messages)) {
          setInitialMessages(data.messages.map(toMessage));
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [params.id]);

  /**
   * The text of the turn currently in flight.
   *
   * Held in a ref because a failed send loses it from BOTH places it normally lives:
   * useChat clears the input on submit, and its restoreMessagesOnFailure() then strips
   * the message back out of the transcript. Without this the user's typing is simply
   * gone and there is nothing left to retry.
   */
  const lastAttemptRef = useRef("");

  const {
    messages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    append,
    data,
    setData,
    stop,
    error,
  } = useChat({
    api: "/api/chat",
    // The conversation is the source of truth; the model is just the tool answering
    // the next turn. Switching it keeps the same conversationId, history and summary.
    body: { conversationId: params.id, model: modelId },
    initialMessages,
    // Put the text back where the user can see and edit it. The banner says what went
    // wrong; this is what makes the failure recoverable without retyping.
    onError: () => {
      if (lastAttemptRef.current) setInput(lastAttemptRef.current);
    },
  });

  // Progress parts accumulate across turns; clear them when a new turn starts.
  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      lastAttemptRef.current = input;
      setData([]);
      setStopped(false);
      handleSubmit(event);
    },
    [handleSubmit, setData, input]
  );

  const appendMessage = useCallback(
    (message: { role: "user"; content: string }) => {
      lastAttemptRef.current = message.content;
      setData([]);
      setStopped(false);
      return append(message);
    },
    [append, setData]
  );

  /**
   * Resend the message that failed.
   *
   * `append` rather than useChat's `reload()`: reload re-sends the last request derived
   * from `messages`, and the failed user message is no longer in `messages` — the SDK
   * removed it. Reloading would replay the PREVIOUS successful turn instead of the one
   * that broke. Appending the captured text sends what the user actually meant, and
   * clears the input so the same text is not left sitting there twice.
   */
  const retryLastMessage = useCallback(() => {
    const text = lastAttemptRef.current;
    if (!text || isLoading) return;
    setInput("");
    void appendMessage({ role: "user", content: text });
  }, [appendMessage, isLoading, setInput]);

  /**
   * Cancel an in-flight generation when this page goes away.
   *
   * A stream that is abandoned rather than cancelled keeps holding one of the user's
   * three concurrency slots server-side for as long as it runs, and a slow turn was
   * measured at 26 seconds. Navigating away from a few of those exhausts the pool and
   * the next message comes back an instant 429. The ref keeps the dependency list empty
   * so this fires on unmount only, never on re-render.
   */
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  // Cancels the in-flight generation. Whatever streamed so far is kept.
  const stopGeneration = useCallback(() => {
    stop();
    setStopped(true);
  }, [stop]);

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-white">
        <div className="flex gap-2">
          <div className="w-2 h-2 rounded-full bg-gray-300 animate-pulse" />
          <div className="w-2 h-2 rounded-full bg-gray-300 animate-pulse delay-75" />
          <div className="w-2 h-2 rounded-full bg-gray-300 animate-pulse delay-150" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-white font-sans selection:bg-blue-100 selection:text-blue-900">
      <Sidebar />
      <div className="flex-1 flex flex-col md:ml-64 h-full relative">
        <header className="h-14 border-b border-gray-200 flex items-center px-4 md:px-6 justify-between bg-white z-10 shrink-0">
          <h1 className="font-semibold text-[15px] text-gray-900 tracking-tight">
            CodeMind Workspace
          </h1>
          <div className="flex items-center gap-2">
            <ProjectSwitcher activeProjectId={projectId} />
            <ModelSelector value={modelId} onChange={setModelId} disabled={isLoading} />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 scroll-smooth scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent">
          <div className="max-w-3xl mx-auto space-y-8 pb-10">
            {messages.map((m) => (
              <ChatMessage key={m.id} message={m} />
            ))}
            {isLoading && <ThinkingIndicator data={data} />}
            {!isLoading && stopped && (
              <p className="ml-4 text-[12px] font-medium text-gray-400">Generation stopped</p>
            )}
            {/* Sits where the reply would have been, so the failure lands where the
                user is already looking rather than in a corner. */}
            {error && !isLoading && (
              <ChatError error={error} onRetry={retryLastMessage} disabled={isLoading} />
            )}
          </div>
        </div>

        <div className="p-4 bg-white shrink-0">
          <Composer
            input={input}
            handleInputChange={handleInputChange}
            handleSubmit={submit}
            append={appendMessage}
            isLoading={isLoading}
            stop={stopGeneration}
          />
        </div>
      </div>
    </div>
  );
}
