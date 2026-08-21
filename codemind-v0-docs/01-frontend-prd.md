# Frontend PRD & Technical Design
## Project: TaskSaaS (CodeMind v0 Demo Application)
### Version 1.0.0

---

## 1. Executive Summary

The frontend is a Next.js 14 App Router application using Server Components by default, Client Components only where interactivity requires it (forms, filters). Styling is Tailwind CSS utility classes exclusively — no custom CSS files, per the locked design constraint.

---

## 2. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Framework | Next.js 14 (App Router) | Same codebase as backend API routes |
| Language | TypeScript (strict) | Shared types with backend via `types/task.ts` |
| Styling | Tailwind CSS | Utility-first, no design-system generator needed at this scope |
| Forms | React Hook Form + Zod resolver | Client-side validation mirrors backend Zod schemas |
| Auth (client) | NextAuth.js `useSession()` / `auth()` | Session state for route protection and UI conditionals |
| Data fetching | Native `fetch` in Server Components; client fetch wrapper for mutations | No SWR/React Query in v0 — kept minimal |

---

## 3. Page Inventory

| Route | Name | Auth Required | Purpose |
|---|---|---|---|
| `/` | Home | No | Landing page with product pitch + "Sign in with Google" CTA |
| `/login` | Login | No | Google OAuth sign-in button |
| `/dashboard` | Dashboard | Yes | List of user's tasks, filterable by status/priority |
| `/tasks/new` | New Task | Yes | Create-task form |
| `/tasks/[id]` | Task Detail | Yes | View, edit, or delete a single task |

**Unauthenticated access to a protected route:** redirect to `/login` server-side (via `auth()` check in the page's Server Component), not a client-side flash-then-redirect.

---

## 4. Component Inventory

| Component | Type | Purpose |
|---|---|---|
| `Navbar` | Server + Client hybrid | Logo, nav links, user avatar (from session), logout button |
| `TaskCard` | Server | Renders one task: title, status badge, priority badge, due date |
| `TaskForm` | Client | Reusable create/edit form — used by both `/tasks/new` and `/tasks/[id]` edit mode |
| `TaskFilter` | Client | Status/priority dropdown filters, updates URL search params |
| `AuthGuard` | Server (layout-level) | Wraps protected route groups, redirects unauthenticated users |
| `StatusBadge` | Server | Small colored label for TODO/IN_PROGRESS/DONE |
| `PriorityBadge` | Server | Small colored label for LOW/MEDIUM/HIGH |
| `EmptyState` | Server | Shown on dashboard when user has zero tasks |
| `LoadingSpinner` | Client | Shown during client-side mutation requests |

---

## 5. State Management

**Deliberately minimal for v0:**
- **Server state (task data):** fetched server-side per page load via Prisma directly in Server Components where possible, or via the API routes for client-triggered mutations. No global client state store (no Redux/Zustand) — not justified at this scope.
- **Filter state:** lives in URL search params (`?status=TODO&priority=HIGH`), not component state — this makes filtered views shareable/bookmarkable and avoids needing a state library.
- **Form state:** local to `TaskForm` via React Hook Form.

---

## 6. Data Fetching Pattern

**Reads (dashboard, task detail):** Server Components query Prisma directly — no API round-trip needed since the page is rendered server-side and already has the authenticated session.

```typescript
// app/dashboard/page.tsx (Server Component)
export default async function Dashboard({ searchParams }: { searchParams: { status?: string } }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const tasks = await prisma.task.findMany({
    where: {
      userId: session.user.id,
      ...(searchParams.status ? { status: searchParams.status as TaskStatus } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return <TaskList tasks={tasks} />;
}
```

**Writes (create/update/delete):** Client Components call the `/api/tasks*` routes via a thin fetch wrapper, then trigger a router refresh:

```typescript
// lib/api-client.ts
export async function createTask(input: CreateTaskInput) {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

```typescript
// In TaskForm's submit handler
await createTask(data);
router.refresh(); // re-fetches the Server Component tree
router.push("/dashboard");
```

---

## 7. Form Validation

`TaskForm` uses the **same Zod schema** as the backend (`CreateTaskSchema`, imported from a shared `lib/validation.ts` module) via `@hookform/resolvers/zod`. This guarantees client and server validation never drift — a single source of truth, consistent with the manifest-driven design principle used elsewhere in this project.

---

## 8. Error & Loading States

| State | Handling |
|---|---|
| Form validation error | Inline field-level messages from Zod/React Hook Form |
| API mutation failure (network/500) | Toast/banner error message, form remains editable, no data loss |
| Page-level fetch failure | Next.js `error.tsx` boundary per route segment |
| Loading (mutation in flight) | Disable submit button, show `LoadingSpinner` |
| Loading (page navigation) | Next.js `loading.tsx` skeleton per route segment |
| Empty dashboard | `EmptyState` component with a "create your first task" CTA, not a blank page |

---

## 9. Accessibility Baseline (v0 scope)

- All interactive elements keyboard-navigable (native HTML elements, no custom click-only divs)
- Form inputs have associated `<label>` elements
- Status/priority badges use both color and text (not color alone) to convey meaning
- Sufficient color contrast on Tailwind badge colors (verified against WCAG AA, not automated in CI yet — manual check for v0)

Full accessibility audit tooling (axe-core in CI, screen reader testing) is deferred to Phase 1+.

---

## 10. Explicitly Out of Scope for v0

- Dark mode
- Internationalization
- Optimistic UI updates
- Offline support / PWA
- Animation/transition library
- Component-level unit test coverage beyond smoke tests
- Custom design system / component library generator

---

## 11. Verification Checklist (Frontend Layer)

| Check | Method | Pass Criteria |
|---|---|---|
| Build | `npm run build` | Exits 0, no TypeScript errors |
| Route protection | Manual: visit `/dashboard` while logged out | Redirects to `/login` |
| CRUD round-trip | Manual/smoke test | Create → appears on dashboard → edit persists → delete removes |
| No console errors | Browser DevTools during full user flow | Clean console, client and server |
| Responsive check | Manual at 375px / 768px / 1280px widths | No horizontal overflow, usable at all three |
