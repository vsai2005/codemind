"use client";

import { useChat } from "ai/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { useCallback, useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/conversations/${params.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
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

  const { messages, input, handleInputChange, handleSubmit, isLoading, append, data, setData, stop } =
    useChat({
      api: "/api/chat",
      // The conversation is the source of truth; the model is just the tool answering
      // the next turn. Switching it keeps the same conversationId, history and summary.
      body: { conversationId: params.id, model: modelId },
      initialMessages,
    });

  // Progress parts accumulate across turns; clear them when a new turn starts.
  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      setData([]);
      setStopped(false);
      handleSubmit(event);
    },
    [handleSubmit, setData]
  );

  const appendMessage = useCallback(
    (message: { role: "user"; content: string }) => {
      setData([]);
      setStopped(false);
      return append(message);
    },
    [append, setData]
  );

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
