# CodeMind v0 — TaskSaaS Engineering Documentation

Demo application: **task management SaaS with Google login** — the exact scenario from the CodeMind v0 6-week build plan.

## Contents

| File | Domain |
|---|---|
| `00-architecture.md` | System architecture — how all layers connect via the Project Manifest |
| `01-frontend-prd.md` | Frontend PRD & technical design (Next.js, pages, components, state) |
| `02-backend-prd.md` | Backend PRD & technical design (API routes, auth, validation) |
| `03-database-prd.md` | Database PRD & technical design (schema, constraints, indexing) |

## Scope note

These documents are scoped to the **v0 vertical slice** (6-8 week solo build, single agent, single model, greenfield only, local Docker deployment) — not the full 36-month enterprise platform. Enterprise concerns (SOC 2, multi-region, RBAC, disaster recovery) are deliberately out of scope here and belong in the Phase 2+ roadmap documents.

Read order: start with `00-architecture.md` for the system-level view, then the three domain PRDs in any order — each is self-contained but cross-references the manifest structure established in the architecture doc.
