# Backend PRD & Technical Design
## Project: TaskSaaS (CodeMind v0 Demo Application)
### Version 1.0.0

---

## 1. Executive Summary

The backend is implemented entirely as Next.js 14 API Route Handlers (App Router, `app/api/**/route.ts`) — no separate server process. This keeps the v0 vertical slice to a single deployable unit, per the locked architecture decision (one codebase, one framework, no service-to-service coordination).

---

## 2. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Next.js 14 API Routes | Same codebase as frontend, zero extra infra |
| Language | TypeScript (strict mode) | Type safety end-to-end with Prisma-generated types |
| ORM | Prisma Client | Type-safe queries, matches DB PRD schema exactly |
| Auth | NextAuth.js v5 (Auth.js) | Session validation, Google OAuth, JWT strategy |
| Validation | Zod | Runtime input validation derived from manifest `shared_types` |
| Error format | Consistent JSON envelope | Predictable frontend error handling |

---

## 3. Authentication & Session Model

- **Strategy:** JWT sessions via NextAuth.js (`session: { strategy: "jwt" }`)
- **Provider:** Google OAuth only for v0 (credentials/GitHub deferred)
- **Session access in route handlers:**

```typescript
import { auth } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // proceed with session.user.id as the ownership filter
}
```

- **Authorization rule (single rule for v0):** every data-access query is scoped to `userId: session.user.id`. There is no cross-user data access path in v0 — no admin override, no team sharing. `Role.ADMIN` exists in the schema for future use but has no special-cased backend logic yet.

---

## 4. API Specification

Base path: `/api`. All routes below return the JSON envelope `{ data: T }` on success or `{ error: string }` on failure.

### 4.1 `GET /api/tasks`
| | |
|---|---|
| Auth | Required |
| Query params | `status?: TaskStatus`, `priority?: TaskPriority` (optional filters) |
| Response `200` | `Task[]` |
| Response `401` | Unauthenticated |
| Behavior | Returns tasks where `userId = session.user.id`, optionally filtered, ordered by `createdAt desc` |

### 4.2 `POST /api/tasks`
| | |
|---|---|
| Auth | Required |
| Request body | `{ title: string, description?: string, status?: TaskStatus, priority?: TaskPriority, dueDate?: string, tags?: string[] }` |
| Validation | Zod schema: `title` required non-empty string (max 200 chars), `dueDate` must parse as valid ISO 8601 if present |
| Response `201` | Created `Task` |
| Response `400` | Validation error with field-level messages |
| Behavior | Sets `userId` from session — **never trust a client-supplied `userId`** |

### 4.3 `GET /api/tasks/[id]`
| | |
|---|---|
| Auth | Required |
| Response `200` | `Task` |
| Response `404` | Not found, **or** task exists but belongs to a different user (same response — do not leak existence of other users' data) |

### 4.4 `PUT /api/tasks/[id]`
| | |
|---|---|
| Auth | Required |
| Request body | Partial `Task` fields |
| Response `200` | Updated `Task` |
| Response `404` | Not found / not owned by requester |
| Behavior | Query must include `WHERE id = :id AND userId = session.user.id` — ownership check happens at the query level, not via a separate `if` check, to avoid TOCTOU gaps |

### 4.5 `DELETE /api/tasks/[id]`
| | |
|---|---|
| Auth | Required |
| Response `200` | `{ success: true }` |
| Response `404` | Not found / not owned |

### 4.6 `ALL /api/auth/[...nextauth]`
Handled entirely by the NextAuth.js library — not custom logic. Do not add business logic to this route.

---

## 5. Request Handler Pattern (Template)

Every route handler in the codebase follows this exact shape, so the code generator produces consistent, reviewable output:

```typescript
export async function POST(req: Request) {
  // 1. Authenticate
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse + validate input
  const body = await req.json();
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // 3. Query database (scoped to session user)
  const task = await prisma.task.create({
    data: { ...parsed.data, userId: session.user.id },
  });

  // 4. Return JSON
  return Response.json({ data: task }, { status: 201 });
}
```

**Why this matters:** the single agent generates every route from this template plus the manifest's per-route metadata (`purpose`, `input`, `output`). Deviating from the template increases the chance of inconsistent error handling across routes.

---

## 6. Validation Schemas (Zod)

Derived directly from `project_manifest.shared_types`:

```typescript
import { z } from "zod";

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  dueDate: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
});

export const UpdateTaskSchema = CreateTaskSchema.partial();
```

---

## 7. Error Handling Standard

| HTTP Status | Meaning | Body shape |
|---|---|---|
| 400 | Validation failure | `{ error: { fieldErrors: {...} } }` |
| 401 | No/invalid session | `{ error: "Unauthorized" }` |
| 404 | Resource missing or not owned | `{ error: "Not found" }` |
| 500 | Unhandled exception | `{ error: "Internal server error" }` — never leak stack traces to the client; log server-side only |

---

## 8. Explicitly Out of Scope for v0

- Rate limiting
- Background job queues / async processing
- Webhooks
- Caching layer (Redis)
- Multi-tenant API keys
- GraphQL/tRPC (REST only, per locked stack decision)
- API versioning scheme

These map to Phase 1–3 of the CodeMind roadmap and should not be pulled forward into the demo build.

---

## 9. Verification Checklist (Backend Layer)

| Check | Method | Pass Criteria |
|---|---|---|
| Type safety | `tsc --noEmit` | 0 errors |
| Build | `npm run build` | Exits 0 |
| Auth enforcement | Manual/smoke test: call `/api/tasks` with no session | Returns 401 |
| Ownership isolation | Smoke test: user A cannot fetch user B's task by ID | Returns 404, not the other user's data |
| CRUD completeness | Smoke test suite | Create, read, update, delete all succeed and persist |
