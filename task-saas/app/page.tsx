import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function LandingPage() {
  const session = await auth();
  
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans selection:bg-blue-100 selection:text-blue-900">
      {/* HEADER */}
      <header className="fixed top-0 w-full border-b border-gray-200 bg-white/80 backdrop-blur-md z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-xl tracking-tight text-gray-900">CodeMind</span>
          </div>
          <div className="flex items-center gap-4">
            <Link 
              href="/login" 
              className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors"
            >
              Sign In
            </Link>
            <Link 
              href="/login" 
              className="text-sm font-medium bg-accent-600 text-white px-4 py-2 rounded-card hover:bg-accent-700 transition-colors shadow-elevated"
            >
              Open Workspace
            </Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <main className="pt-32 pb-16 px-6 max-w-6xl mx-auto flex flex-col items-center text-center">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-gray-900 mb-6">
          Your engineering workspace,<br/>with intelligence built in.
        </h1>
        <p className="text-lg text-gray-500 max-w-2xl mb-10 leading-relaxed font-medium">
          CodeMind helps you think, build, debug, and work with software through a professional conversational interface.
        </p>
        
        <div className="flex gap-4 mb-20">
          <Link 
            href="/login" 
            className="text-sm font-medium bg-accent-600 text-white px-6 py-3 rounded-card hover:bg-accent-700 transition-all shadow-elevated hover:shadow-dropdown"
          >
            Open CodeMind
          </Link>
        </div>

        {/* HERO VISUAL */}
        <div className="w-full max-w-4xl bg-white rounded-xl border border-gray-200 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden text-left mb-32 relative group">
          <div className="h-12 border-b border-gray-100 bg-gray-50 flex items-center px-4 gap-2">
            <div className="w-3 h-3 rounded-full bg-gray-300"></div>
            <div className="w-3 h-3 rounded-full bg-gray-300"></div>
            <div className="w-3 h-3 rounded-full bg-gray-300"></div>
            <div className="ml-4 bg-white border border-gray-200 rounded-md px-3 py-1 flex-1 max-w-sm flex items-center">
              <span className="text-[11px] text-gray-400 font-medium">codemind.dev / workspace</span>
            </div>
          </div>
          <div className="flex h-[400px]">
            <div className="w-56 border-r border-gray-100 bg-gray-50 p-5 hidden sm:block">
              <div className="h-4 w-24 bg-gray-200 rounded mb-6"></div>
              <div className="h-3 w-32 bg-gray-200 rounded mb-3"></div>
              <div className="h-3 w-28 bg-gray-200 rounded mb-3"></div>
              <div className="h-3 w-36 bg-gray-200 rounded mb-3"></div>
            </div>
            <div className="flex-1 p-8 flex flex-col justify-end">
              <div className="bg-gray-100 p-4 rounded-xl border border-gray-200/60 max-w-[80%] self-end mb-6 shadow-sm">
                <span className="text-sm text-gray-800 font-medium">How do I implement a resilient streaming queue?</span>
              </div>
              <div className="max-w-[85%] mb-4">
                <div className="h-3 w-16 bg-gray-300 rounded mb-3"></div>
                <div className="h-3 w-64 bg-gray-200 rounded mb-2"></div>
                <div className="h-3 w-56 bg-gray-200 rounded mb-5"></div>
                <div className="h-32 w-full bg-gray-50 border border-gray-200 rounded-lg"></div>
              </div>
            </div>
          </div>
        </div>

        {/* VALUE PROPOSITION */}
        <div className="grid md:grid-cols-3 gap-12 max-w-4xl w-full text-left mb-32">
          <div>
            <h3 className="text-gray-900 font-bold mb-3 text-lg">Think</h3>
            <p className="text-[15px] text-gray-500 leading-relaxed font-medium">
              Resolve ambiguity before writing code. Work through complex architectural decisions with Nemotron 3 Ultra.
            </p>
          </div>
          <div>
            <h3 className="text-gray-900 font-bold mb-3 text-lg">Build</h3>
            <p className="text-[15px] text-gray-500 leading-relaxed font-medium">
              Generate precise implementations. Receive well-structured code blocks formatted for immediate use.
            </p>
          </div>
          <div>
            <h3 className="text-gray-900 font-bold mb-3 text-lg">Iterate</h3>
            <p className="text-[15px] text-gray-500 leading-relaxed font-medium">
              Refine your work. Conversations persist in PostgreSQL, giving you a continuous context for your engineering tasks.
            </p>
          </div>
        </div>

        {/* FINAL CTA */}
        <div className="mb-20 bg-gray-50 p-12 rounded-2xl border border-gray-200 w-full max-w-4xl">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Start building with CodeMind.</h2>
          <Link 
            href="/login" 
            className="text-sm font-medium bg-accent-600 text-white px-8 py-3.5 rounded-card hover:bg-accent-700 transition-all inline-block shadow-elevated"
          >
            Open CodeMind
          </Link>
        </div>
      </main>

      <footer className="border-t border-gray-200 py-8 text-center bg-gray-50">
        <span className="text-xs text-gray-400 font-medium tracking-wide">CodeMind 1.0 — Intelligent Workspace</span>
      </footer>
    </div>
  );
}
