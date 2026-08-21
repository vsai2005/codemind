"use client";

import { useChat } from "ai/react";
import { useCallback, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Composer } from "@/components/chat/Composer";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ModelSelector } from "@/components/chat/ModelSelector";

export default function DashboardPage() {
  // Applies to the NEXT generation. Null means "use the server default".
  const [modelId, setModelId] = useState<string | null>(null);

  const [stopped, setStopped] = useState(false);

  const { messages, input, handleInputChange, handleSubmit, isLoading, append, data, setData, stop } =
    useChat({
      api: "/api/chat",
      // Read at request time, so switching models takes effect on the next message
      // without remounting the chat or losing any history.
      body: { model: modelId },
      onResponse: (response) => {
        const id = response.headers.get("x-conversation-id");
        if (id) {
          window.history.pushState({}, "", `/chat/${id}`);
        }
      },
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

  // Cancels the in-flight generation. Whatever streamed so far is kept.
  const stopGeneration = useCallback(() => {
    stop();
    setStopped(true);
  }, [stop]);

  const appendMessage = useCallback(
    (message: { role: "user"; content: string }) => {
      setData([]);
      setStopped(false);
      return append(message);
    },
    [append, setData]
  );

  return (
    <div className="flex h-screen bg-white font-sans selection:bg-blue-100 selection:text-blue-900">
      <Sidebar />
      <div className="flex-1 flex flex-col md:ml-64 h-full relative">
        {/* Header */}
        <header className="h-14 border-b border-gray-200 flex items-center px-4 md:px-6 justify-between bg-white z-10 shrink-0">
          <h1 className="font-semibold text-[15px] text-gray-900 tracking-tight">CodeMind Workspace</h1>
          <div className="flex items-center gap-2">
            <ModelSelector value={modelId} onChange={setModelId} disabled={isLoading} />
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent">
          <div className="max-w-3xl mx-auto space-y-8 pb-10">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full mt-32 text-gray-500">
                <h2 className="text-2xl font-semibold mb-4 text-gray-900">How can I help you build?</h2>
                <div className="flex flex-wrap gap-3 justify-center max-w-lg">
                  {["Review this implementation", "Help me debug an error", "Design an API for...", "Explain this code"].map((prompt) => (
                    <button 
                      key={prompt}
                      onClick={() => handleInputChange({ target: { value: prompt } } as any)}
                      className="text-[13px] font-medium bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 py-2 px-4 rounded-full transition-all shadow-sm hover:shadow"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(m => <ChatMessage key={m.id} message={m} />)
            )}
            {isLoading && <ThinkingIndicator data={data} />}
            {!isLoading && stopped && (
              <p className="ml-4 text-[12px] font-medium text-gray-400">Generation stopped</p>
            )}
          </div>
        </div>

        {/* Input Area */}
        <div className="p-4 bg-white shrink-0">
          <Composer input={input} handleInputChange={handleInputChange} handleSubmit={submit} append={appendMessage} isLoading={isLoading} stop={stopGeneration} />
        </div>
      </div>
    </div>
  );
}
