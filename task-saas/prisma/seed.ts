import { PrismaClient, TaskStatus, TaskPriority } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log("Seeding database...");

  // Create demo user
  const user = await prisma.user.upsert({
    where: { email: "demo@example.com" },
    update: {},
    create: {
      email: "demo@example.com",
      name: "Demo User",
      image: "https://via.placeholder.com/150",
    },
  });

  console.log(`Created user: ${user.email}`);

  // Create sample tasks
  const tasks = [
    {
      title: "Set up project repository",
      description: "Initialize the Git repository and set up the project structure.",
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      tags: ["setup", "infrastructure"],
      userId: user.id,
    },
    {
      title: "Design database schema",
      description: "Create the Prisma schema with all required models and relationships.",
      status: TaskStatus.DONE,
      priority: TaskPriority.HIGH,
      tags: ["database", "design"],
      userId: user.id,
    },
    {
      title: "Implement authentication",
      description: "Set up NextAuth.js with Google OAuth provider.",
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.HIGH,
      tags: ["auth", "security"],
      userId: user.id,
    },
    {
      title: "Build task management API",
      description: "Create REST API endpoints for CRUD operations on tasks.",
      status: TaskStatus.TODO,
      priority: TaskPriority.MEDIUM,
      tags: ["api", "backend"],
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      userId: user.id,
    },
    {
      title: "Create frontend dashboard",
      description: "Build the main dashboard with task list, filters, and create form.",
      status: TaskStatus.TODO,
      priority: TaskPriority.MEDIUM,
      tags: ["frontend", "ui"],
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      userId: user.id,
    },
  ];

  for (const task of tasks) {
    await prisma.task.create({ data: task });
  }

  console.log(`Created ${tasks.length} sample tasks`);
  console.log("Seeding complete.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
