import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { Navbar } from "@/components/layout/Navbar";
import { TaskDetailClient } from "@/components/tasks/TaskDetailClient";

interface TaskDetailPageProps {
  params: { id: string };
}

export default async function TaskDetailPage({
  params,
}: TaskDetailPageProps): Promise<React.ReactElement> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const task = await prisma.task.findFirst({
    where: {
      id: params.id,
      userId: session.user.id,
    },
  });

  if (!task) {
    notFound();
  }

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <TaskDetailClient task={JSON.parse(JSON.stringify(task))} />
      </main>
    </>
  );
}
