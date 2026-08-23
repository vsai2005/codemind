"use client";

import { useChat } from "ai/react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { ChatError } from "@/components/chat/ChatError";
import { ProjectSwitcher } from "@/components/projects/ProjectSwitcher";

/**
 * The workspace shell.
 *
 * `useSearchParams` opts its subtree out of static rendering: on a prerendered route,
 * Next client-renders everything up to the nearest Suspense boundary. With no boundary
 * at all that was the entire page, so the prerendered HTML for the app's main entry
 * point was an empty div and the sidebar only appeared after hydration.
 *
 * The boundary here contains only the part that actually needs the query string. The
 * frame and the navigation rail prerender as static HTML again.
 */
export default function DashboardPage(): React.ReactElement {
  return (
    <div className="flex h-screen bg-white font-sans selection:bg-blue-100 selection:text-blue-900">
      <Sidebar />
      <Suspense fallback={<WorkspaceFallback />}>
        <ChatWorkspace />
      </Suspense>
    </div>
  );
}

/** Matches the real pane's frame so the boundary resolving causes no layout shift. */
function WorkspaceFallback(): React.ReactElement {
  return (
    <div className="relative flex h-full flex-1 flex-col md:ml-64">
      <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 md:px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-gray-900">
          CodeMind Workspace
        </h1>
      </header>
      <div className="flex-1" />
    </div>
  );
}

function ChatWorkspace(): React.ReactElement {
  // Applies to the NEXT generation. Null means "use the server default".
  const [modelId, setModelId] = useState<string | null>(null);

  const [stopped, setStopped] = useState(false);

  /**
   * The conversation the server filed this chat under, learned from the
   * x-conversation-id response header.
   *
   * Held in state and sent back on every later request. Without it each message from
   * this still-mounted page arrived with no conversationId and the server opened a
   * NEW conversation for it, so a dashboard session scattered its turns across
   * several conversations while the URL claimed one. pushState alone did not fix
   * that: it rewrites the address bar without remounting, so the request body was
   * never updated.
   *
   * The server sets the header on failures too, which is what stops a retry after a
   * 503 from starting a second conversation.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);

  // A chat started from a project workspace arrives as ?project=<id>. The server
  // re-checks ownership before filing the conversation, so this is a hint, not a grant.
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project");

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
    // Read at request time, so switching models takes effect on the next message
    // without remounting the chat or losing any history.
    body: { model: modelId, projectId, conversationId },
    onResponse: (response) => {
      const id = response.headers.get("x-conversation-id");
      if (id) {
        // Recorded before the address bar is touched: this is what keeps the rest of
        // the session, and any retry, inside the same conversation.
        setConversationId(id);
        window.history.pushState({}, "", `/chat/${id}`);
      }
    },
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

  // Cancels the in-flight generation. Whatever streamed so far is kept.
  const stopGeneration = useCallback(() => {
    stop();
    setStopped(true);
  }, [stop]);

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

  return (
    <div className="relative flex h-full flex-1 flex-col md:ml-64">
      {/* Header */}
      <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 md:px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-gray-900">
          CodeMind Workspace
        </h1>
        <div className="flex items-center gap-2">
          <ProjectSwitcher activeProjectId={projectId} />
          <ModelSelector value={modelId} onChange={setModelId} disabled={isLoading} />
        </div>
      </header>

      {/* Chat Area */}
      <div className="scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent flex-1 scroll-smooth overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-8 pb-10">
          {messages.length === 0 ? (
            <div className="mt-32 flex h-full flex-col items-center justify-center text-gray-500">
              <h2 className="mb-4 text-2xl font-semibold text-gray-900">
                How can I help you build?
              </h2>
              <div className="flex max-w-lg flex-wrap justify-center gap-3">
                {[
                  "Review this implementation",
                  "Help me debug an error",
                  "Design an API for...",
                  "Explain this code",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    // setInput rather than a fabricated change event: the previous cast
                    // to `any` existed only to satisfy handleInputChange's signature.
                    onClick={() => setInput(prompt)}
                    className="rounded-full border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 hover:shadow"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}
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

      {/* Input Area */}
      <div className="shrink-0 bg-white p-4">
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
  );
}
