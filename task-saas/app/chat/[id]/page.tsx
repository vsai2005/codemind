"use client";

import { useChat } from "ai/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { TokenUsage } from "@/components/chat/TokenUsage";
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
  /** Present only on a truncated whole-file edit. See Message.editTruncation. */
  editTruncation?: unknown;
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
  // A truncated edit warns on the live stream; without this it would come back after a
  // reload looking like a complete file.
  if (stored.editTruncation) {
    annotations.push({ codemindEditTruncated: stored.editTruncation } as unknown as JSONValue);
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
  /**
   * Set when the server says a reply to the last message is still being written.
   *
   * A generation outlives the reader: leaving a conversation detaches the stream
   * instead of killing it, so the answer keeps being written and is persisted when it
   * lands. What was missing is the other half — on coming back, this page fetched the
   * history once, found no reply, and showed a conversation that looked dead. The work
   * was never lost; it was invisible.
   */
  const [pendingSince, setPendingSince] = useState<string | null>(null);
  /** See the error-ownership effect below. Null means "no error to show here". */
  const [errorForId, setErrorForId] = useState<string | null>(null);

  const loadConversation = useCallback(async (): Promise<StoredMessage[] | null> => {
    const res = await fetch(`/api/conversations/${params.id}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.projectId === "string") setProjectId(data.projectId);
    setPendingSince(typeof data?.pendingSince === "string" ? data.pendingSince : null);
    return Array.isArray(data?.messages) ? (data.messages as StoredMessage[]) : null;
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
    setMessages,
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

  /**
   * Latest-value refs for useChat's setters.
   *
   * The load effect below must not re-run when these change identity, or setLoading(true)
   * inside it would trigger the render that changes them again. Reading them through a
   * ref keeps the effect keyed on the conversation and nothing else.
   */
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;
  const setDataRef = useRef(setData);
  setDataRef.current = setData;

  /**
   * Load the conversation, and RESET what the previous one left behind.
   *
   * Next reuses this component across /chat/[id] navigations — same route, different
   * param — so every piece of state here survives a conversation switch unless it is
   * explicitly cleared. Without these resets, switching showed the previous
   * conversation's transcript, its "Generation stopped" line and its progress parts
   * until the new fetch resolved. That is milliseconds on localhost and long enough to
   * read on a slow connection, and it is wrong for the whole of it.
   *
   * `loading` returning to true is what puts the spinner up in place of stale content.
   * A brief spinner is the right failure here: showing one conversation's replies
   * underneath another conversation's title is worse than showing nothing.
   *
   * setMessages is needed as well as setInitialMessages because useChat keeps its own
   * copy once a turn has been sent, and stops tracking the initialMessages prop.
   */
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setPendingSince(null);
    setStopped(false);
    setErrorForId(null);
    setDataRef.current([]);
    setMessagesRef.current([]);

    void loadConversation()
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          const mapped = stored.map(toMessage);
          setInitialMessages(mapped);
          setMessagesRef.current(mapped);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadConversation]);

  /**
   * Which conversation the current useChat error belongs to.
   *
   * useChat exposes no way to clear `error`, and the hook instance survives navigation,
   * so a failure in one conversation would otherwise keep its banner on screen in the
   * next one — an error message about a message that is not even displayed.
   *
   * Recorded on the TRANSITION to a new error, not whenever `error` is truthy: the
   * latter would re-tag the stale error with the new conversation's id on arrival,
   * which is precisely the bug.
   */
  const previousErrorRef = useRef(error);
  useEffect(() => {
    if (error && error !== previousErrorRef.current) {
      setErrorForId(typeof params.id === "string" ? params.id : null);
    }
    previousErrorRef.current = error;
  }, [error, params.id]);

  /**
   * Watch for a reply being written by a generation this page is not streaming.
   *
   * Only runs when the server reported one pending AND useChat is not itself
   * streaming — during a local turn the stream is the source of truth and polling
   * beside it would race, showing a half-written reply twice.
   *
   * Polling rather than a socket because the reply arrives exactly once and the page
   * only needs to notice within a few seconds; a persistent connection to learn a
   * single fact would cost more than it saves. It stops the moment the reply lands or
   * the server stops calling the turn pending, so an abandoned generation cannot leave
   * the tab polling forever.
   */
  useEffect(() => {
    if (!pendingSince || isLoading) return;

    let cancelled = false;
    const interval = setInterval(() => {
      void loadConversation()
        .then((stored) => {
          if (cancelled || !stored) return;
          const answered = stored[stored.length - 1]?.role === "assistant";
          // Replace wholesale rather than appending: the reply may arrive with plan and
          // artifact annotations attached, and toMessage is what rebuilds those into
          // the same shape the live stream produces.
          if (answered) setMessagesRef.current(stored.map(toMessage));
        })
        .catch(() => {
          // A failed poll is not a failed generation. Leave the indicator up and try
          // again on the next tick rather than declaring the turn dead.
        });
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // setMessages is reached through a ref, not a dependency: listing it would rebuild
    // the interval on any render that changed its identity, and an interval rebuilt
    // more often than its own period never fires at all.
  }, [pendingSince, isLoading, loadConversation]);

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
            {/*
              Beside the model selector because the two are read together: which model
              answered, and what it cost in tokens. isLoading drives the refetch — the
              total is only meaningful once a turn has settled and its usage is stored.
            */}
            <TokenUsage
              conversationId={typeof params.id === "string" ? params.id : null}
              isStreaming={isLoading}
            />
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
            {!isLoading && pendingSince && (
              // The reply is being written somewhere this page is not watching. Saying
              // so is the whole point: the previous behaviour was indistinguishable
              // from a turn that had silently failed.
              <div className="ml-4 flex items-center gap-2 text-[13px] text-gray-500">
                <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-500" />
                Still writing a reply you started earlier — it will appear here when it
                finishes.
              </div>
            )}
            {!isLoading && stopped && (
              <p className="ml-4 text-[12px] font-medium text-gray-400">Generation stopped</p>
            )}
            {/* Sits where the reply would have been, so the failure lands where the
                user is already looking rather than in a corner. */}
            {error && errorForId === params.id && !isLoading && (
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
