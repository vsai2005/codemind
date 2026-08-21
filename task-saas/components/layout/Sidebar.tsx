import Link from "next/link";
import { useEffect, useState } from "react";
import { Conversation } from "@prisma/client";
import { useRouter, usePathname } from "next/navigation";
import { AccountMenu } from "@/components/auth/AccountMenu";

export function Sidebar() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const router = useRouter();
  const pathname = usePathname();

  const fetchConversations = async () => {
    const res = await fetch("/api/conversations");
    if (res.ok) {
      const data = await res.json();
      setConversations(data);
    }
  };

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 5000);
    return () => clearInterval(interval);
  }, []);

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Delete this conversation?")) {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      setConversations(conversations.filter(c => c.id !== id));
      if (pathname === `/chat/${id}`) {
        router.push("/dashboard");
      }
    }
  };

  return (
    <div className="w-64 bg-[#F9FAFB] text-gray-600 hidden md:flex flex-col fixed left-0 top-0 border-r border-gray-200 z-50 h-screen">
      <div className="h-14 flex items-center px-4 border-b border-gray-200">
        <Link href="/dashboard" className="text-[15px] font-semibold tracking-tight text-gray-900 hover:opacity-80 transition-opacity">
          CodeMind
        </Link>
      </div>
      
      <div className="p-3">
        <Link 
          href="/dashboard"
          className="flex items-center gap-2 w-full text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 border border-gray-200 py-2 px-3 rounded-[6px] shadow-sm transition-colors"
        >
          <span className="text-gray-400">+</span> New Chat
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">
          Recent
        </h3>
        <div className="space-y-[2px]">
          {conversations.map((conv) => {
            const isActive = pathname === `/chat/${conv.id}`;
            return (
              <div 
                key={conv.id} 
                className={`group flex items-center justify-between rounded-[6px] ${isActive ? "bg-gray-200 text-gray-900" : "hover:bg-gray-100"}`}
              >
                <Link 
                  href={`/chat/${conv.id}`}
                  className="flex-1 truncate text-[13px] font-medium py-[6px] px-2 transition-colors"
                >
                  {conv.title || "New Conversation"}
                </Link>
                <button 
                  onClick={(e) => deleteConversation(conv.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 text-gray-400 hover:text-red-500 transition-opacity"
                  title="Delete conversation"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"></path></svg>
                </button>
              </div>
            );
          })}
          {conversations.length === 0 && (
            <p className="text-gray-500 text-[13px] px-2 mt-2">No history</p>
          )}
        </div>
      </div>

      <AccountMenu />
    </div>
  );
}
