import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock the auth and prisma modules
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }
  }
}));

import { GET as getTasks } from "@/app/api/tasks/route";
import { GET as getTask } from "@/app/api/tasks/[id]/route";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

describe("Tasks API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    // Mock no session
    (auth as any).mockResolvedValue(null);

    const req = new Request("http://localhost:3000/api/tasks");
    const res = await getTasks(req);
    
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("enforces ownership isolation (User A cannot access User B task)", async () => {
    // Mock user A
    (auth as any).mockResolvedValue({ user: { id: "user-a" } });
    
    // Mock task lookup finding nothing (because prisma query includes userId: "user-a" but task is user B's)
    (prisma.task.findFirst as any).mockResolvedValue(null);

    const req = new Request("http://localhost:3000/api/tasks/task-b");
    const res = await getTask(req, { params: { id: "task-b" } });
    
    expect(res.status).toBe(404);
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: {
        id: "task-b",
        userId: "user-a"
      }
    });
  });
});
