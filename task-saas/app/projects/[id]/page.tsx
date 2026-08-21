"use client";

import { useParams } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { ProjectWorkspace } from "@/components/projects/ProjectWorkspace";

/**
 * Project workspace route.
 *
 * Thin shell only: it resolves the id from the URL and hands it to the workspace,
 * reusing the same frame as the chat route so the sidebar lines up identically.
 */
export default function ProjectPage(): React.ReactElement {
  const params = useParams();
  const rawId = params?.id;
  const projectId = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";

  return (
    <div className="flex h-screen bg-white font-sans selection:bg-blue-100 selection:text-blue-900">
      <Sidebar />
      <div className="flex-1 flex flex-col md:ml-64 h-full relative">
        <div className="flex-1 overflow-y-auto scroll-smooth">
          <ProjectWorkspace projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
