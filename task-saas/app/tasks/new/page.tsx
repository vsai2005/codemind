import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Navbar } from "@/components/layout/Navbar";
import { TaskForm } from "@/components/tasks/TaskForm";

export default async function NewTaskPage(): Promise<React.ReactElement> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Create New Task</h1>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <TaskForm mode="create" />
        </div>
      </main>
    </>
  );
}
