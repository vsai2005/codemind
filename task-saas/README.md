# CodeMind V1

CodeMind is an intelligent, AI-first engineering workspace. It provides a professional conversational interface designed for developers to think, build, debug, and iterate on software, backed by NVIDIA NIM and Nemotron 3 Ultra.

## Main V1 Capabilities
- **AI-First Workspace:** Premium, distraction-free conversational UI.
- **Multimodal AI:** Deep reasoning on text, vision on images.
- **Document Analysis:** Extracts and processes text from .pdf, .txt, .md, and source files.
- **Image Analysis:** Llama 3.2 90B Vision Instruct via NVIDIA NIM for diagrams and screenshots.
- **Persistent Context:** History, summaries and artifacts stored in PostgreSQL via Prisma.
- **Downloadable Artifacts:** Project ZIPs, PDFs and single files delivered as download cards, not as walls of source in the chat.
- **Key Failover:** Multiple NVIDIA API keys with automatic cooldown and rotation.

---

## ⚠️ Demo authentication

CodeMind ships with a **one-click local sign-in that has no password**. It opens the
seeded `demo@example.com` workspace. This is a demo convenience, **not** an
authentication system: anyone who can reach the app becomes that same user.

It is gated behind an explicit opt-in:

| `CODEMIND_DEMO_AUTH` | Behaviour |
| --- | --- |
| `true` | One-click demo sign-in is available. Intended for localhost or a trusted LAN. |
| unset / anything else | **No sign-in provider is registered.** Sign-in fails closed; there is no silent fallback to the demo account. |

The flag defaults to **off** so an unconfigured deployment cannot accidentally ship an
open workspace. If you expose CodeMind beyond your own machine, leave it off and
configure a real authentication provider in `auth.ts`.

## 🔑 Secret handling

All API keys are read **server-side only**, from environment variables. They never
appear in browser JavaScript, API responses, logs, the database, chat messages, or
generated ZIP/PDF artifacts — artifact validation actively refuses to package content
containing a live key or a real `.env` file.

> **If any key in your local `.env` has ever been shared outside this machine** — pasted
> into a chat, a screenshot, a ticket, a commit, or a cloud-synced folder — **rotate it
> manually** in the NVIDIA console. This project never rotates your keys for you.

Note that `.env` is correctly gitignored, but a gitignored file inside a cloud-synced
directory (OneDrive, Dropbox, iCloud) still leaves the machine.

---

## Requirements
- Node.js 18+
- PostgreSQL 16
- At least one NVIDIA NIM API key

## Environment Variables

Copy `.env.example` to `.env` and fill it in. Required:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/tasksaas?schema=public"
AUTH_SECRET="generate-with-npx-auth-secret-min-32-chars"
AUTH_TRUST_HOST=true
CODEMIND_DEMO_AUTH=true
NVIDIA_API_KEY_1=
```

`NVIDIA_API_KEY_2` … `NVIDIA_API_KEY_5` (and `NVIDIA_API_KEY`) are optional extra slots
used for automatic failover when a key is rate limited.

Optional tuning: `NEMOTRON_MODEL`, `NEMOTRON_BASE_URL`, `NVIDIA_VISION_MODEL`,
`AI_MAX_OUTPUT_TOKENS`, `AI_CONTEXT_MAX_TOKENS`, `AI_ARTIFACT_MAX_OUTPUT_TOKENS`,
`CODEMIND_DISABLE_RATE_LIMIT`.

> Google OAuth is **not** used. Earlier versions listed `AUTH_GOOGLE_ID` /
> `AUTH_GOOGLE_SECRET` as required; no Google provider is registered anywhere in the
> codebase and those variables are no longer read.

---

## How artifacts work

Asking for a deliverable ("give me the project as a zip", "explain Docker as a PDF",
"create middleware.ts and give me the file") does **not** dump source into the chat.

```
User request → Chat API → intent detection → artifact generation
   → validate files → package → persist → return metadata → download card
```

1. **Intent is decided server-side** (`lib/ai/intent.ts`) before any generation. Normal
   chat runs on a system prompt that contains no artifact instructions at all, so it
   cannot emit `<file path="...">` blocks.
2. **Generation is a separate, non-streaming call** (`lib/artifacts/generate.ts`). Only
   readable progress is streamed: *Planning the project… → Generating files… →
   Validating project structure… → Packaging ZIP… → ready*.
3. **Validation is strict** (`lib/artifacts/validate.ts`). Paths are rejected — never
   rewritten — if they traverse, are absolute, or use Windows/UNC forms. Files that end
   mid-statement, carry a continuation marker, or have unclosed brackets are treated as
   incomplete.
4. **Incomplete output is never packaged.** If generation was cut short you get
   *"No complete project artifact could be generated. Please retry."* and no download
   button, rather than a broken ZIP.
5. **Storage is split.** The assistant message holds only the visible sentence; file
   contents live in the `Artifact` table and are served by
   `GET /api/artifacts/[id]/download`. The browser only ever receives id, type,
   filename, file count and size.

Asking to *see* code ("show me middleware.ts", "show me a React component") stays in
the conversation as an ordinary Markdown code block.

Large projects are **not** handled by raising the output limit indefinitely —
`AI_ARTIFACT_MAX_OUTPUT_TOKENS` is hard-capped at 32000. A project that will not fit
fails honestly instead of producing a truncated archive.

Conversations created before this change still contain inline artifact markup; the
legacy `/api/export/*` routes keep serving them, using the same validation rules.

---

## Rate limits

Expensive endpoints are rate limited per authenticated user (falling back to client IP),
using an in-memory fixed-window counter. Exceeding a limit returns **429** with a
`Retry-After` header.

| Endpoint | Limit |
| --- | --- |
| `POST /api/chat` | 20 requests / minute |
| `POST /api/upload` | 30 requests / minute |
| `POST /api/export/*` | 30 requests / minute |
| `GET /api/artifacts/:id/download` | 60 requests / minute |

Limits are sized so ordinary interactive use never trips them. Set
`CODEMIND_DISABLE_RATE_LIMIT=true` to disable entirely (local development only).

**Limitation:** counters live in process memory. With the current single-container
deployment that is one shared counter set. Across multiple replicas each instance would
enforce its own share — an accepted trade-off to avoid a Redis dependency.

---

## Context limits

Three limits stack, and the smallest one wins:

| Layer | Limit | Where |
| --- | --- | --- |
| NVIDIA NIM hard ceiling | **1,048,576 tokens** | provider-enforced |
| CodeMind context window | **512,000 tokens** | `AI_CONTEXT_MAX_TOKENS` |
| Single message | **2,000,000 chars** (≈500K est. tokens) | `MAX_MESSAGE_CHARS`, `types/chat.ts` |

The provider ceiling was measured directly against
`nvidia/nemotron-3-ultra-550b-a55b` on `integrate.api.nvidia.com`, not taken from
documentation: 1,047,986 prompt tokens succeeded, 1,048,702 returned
`400 — This model's maximum context length is 1048576 tokens`. Output tokens are
budgeted separately and do **not** consume the input ceiling.

**Why 512K and not 1M.** `ContextManager.estimateTokens` approximates at 4 chars per
token. Prose measures ~4.16, so the estimate is mildly conservative there — but dense
code, JSON and lockfiles run 2.5–3.5 chars/token, which flips the estimate to
optimistic. The largest safe window is roughly `262,144 × actual_ratio`:

| Actual chars/token | Max safe window |
| --- | --- |
| 4.16 (prose) | ~1,090,000 |
| 3.5 (typical TS/TSX) | ~917,000 |
| 3.0 (dense JSON) | ~786,000 |
| 2.5 (lockfiles, base64) | ~655,000 |

512K stays inside the ceiling even at 2.0 chars/token. Going higher is viable only
after making the estimator conservative (divide by 3) or clamping raw characters
before dispatch — otherwise an overflow surfaces as a generic 500, because the
provider's 400 is not the same error ContextManager raises for its own budget.

**Keep the two settings in step.** Raising `AI_CONTEXT_MAX_TOKENS` alone does nothing
for a single large paste: `MAX_MESSAGE_CHARS` rejects the request with a 400 before
ContextManager runs.

Note that per-document extraction is still capped at 50,000 characters in
`/api/upload`, independent of these limits.

---

## A note on OneDrive / synced folders

Do not keep this project inside OneDrive, Dropbox, or iCloud. Those clients turn
files into cloud placeholders (reparse points), and `.next` — which Next.js rewrites
on every compile — is the worst possible candidate. The dev server then dies at
startup with `EINVAL: invalid argument, readlink '.next/...'`.

`.next`, `node_modules`, `backups/` and `*.log` are generated artifacts, not source;
they are gitignored and should never be synced. If the error appears, `rm -rf .next`
clears it, but the durable fix is keeping the project outside any synced directory.

## Local Development & Database Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Database setup:**
   ```bash
   npx prisma generate
   npx prisma migrate dev
   npx prisma db seed
   ```
   The seed creates the `demo@example.com` user that demo sign-in requires.
3. **Start the dev server:**
   ```bash
   npm run dev
   ```
   Available at http://localhost:3000.

## Docker Development/Deployment

1. Create your `.env` with the required secrets.
2. Build and start:
   ```bash
   docker compose up -d --build
   ```
3. Verify:
   ```bash
   docker compose ps
   docker compose logs --tail=100
   ```

## Running Tests
```bash
npm run test
```

---

## Production deployment

CodeMind deploys as a standard Next.js application. Every secret is supplied through
environment variables at runtime — nothing sensitive lives in the repository, the
image, or the build.

**1. Clone and install**
```bash
git clone <your-repo-url>
cd codemind/task-saas
npm install
```

**2. Configure environment**

Copy `.env.example` to `.env` and fill it in. At minimum production needs
`DATABASE_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST=true`, and at least one
`NVIDIA_API_KEY_*`. Set `CODEMIND_DEMO_AUTH=false` — anything else lets visitors into
a shared workspace without a password.

On a hosting platform, set these in the platform's environment settings rather than
committing a `.env`.

**3. Generate the Prisma client**
```bash
npx prisma generate
```

**4. Apply migrations** — a separate step, never part of app startup
```bash
npx prisma migrate deploy
```

`migrate deploy` only applies pending migrations forward. Do **not** use
`prisma migrate reset` (drops the database) or `prisma db push` (can drop columns
without a migration record) against production.

**5. Build and start**
```bash
npm run build
npm run start
```

The recommended order is: **build → prisma generate → deploy → migrate deploy.**
Nothing destructive runs when a container starts, so a restart or rollback can never
mutate data as a side effect.

### Docker

`docker compose up -d --build` builds and runs the app; Postgres stays external and
managed. Secrets are passed through `docker-compose.yml` from your environment and
are never baked into the image (`.dockerignore` keeps `.env` out of the build
context entirely).

Migrations run as their own step against the built image:
```bash
docker compose run --rm app npx prisma migrate deploy
```

---

## Migrating to Aiven PostgreSQL

The application only ever reads `DATABASE_URL`. No hostname, user, password, or
database name is hardcoded, so moving to a managed instance is a configuration
change and requires **no code change**.

```
Local PostgreSQL  →  backup  →  Aiven PostgreSQL  →  DATABASE_URL  →  migrations  →  CodeMind
```

**1. Back up first — always**
```bash
./scripts/backup-database.sh --docker task-saas-db-1     # local docker Postgres
./scripts/backup-database.sh                             # any DATABASE_URL
```
Writes a compressed `pg_dump` custom-format file to `backups/`. The script only
reads; it contains no `DROP`, no `TRUNCATE`, and no reset. Verify it before going
further:
```bash
pg_restore --list backups/<file>.dump | head
```

**2. Point at Aiven**

Take the connection string from the Aiven console and set it as `DATABASE_URL`.
Keep the `?sslmode=require` Aiven includes — TLS is mandatory there, and Prisma
honours the parameter from the URL.
```
DATABASE_URL="YOUR_AIVEN_POSTGRES_CONNECTION_STRING"
```

**3. Create the schema**
```bash
npx prisma migrate deploy
```

**4. Import existing data** (only if carrying data over)
```bash
pg_restore --no-owner --no-privileges --data-only -d "$DATABASE_URL" backups/<file>.dump
```
`--data-only` loads rows into the schema the migrations just created.
`--no-owner --no-privileges` avoids referencing local roles that do not exist on
Aiven. Primary keys are preserved, so every ownership relationship — users →
conversations → messages → artifacts — stays intact.

**5. Verify before switching traffic**

Check row counts for `User`, `Conversation`, `Message`, `Artifact` and `Project`
against the source, sign in with an existing account, and confirm password hashes
still authenticate (they are portable — hashing is pure scrypt with parameters
embedded in the stored value).

> **Warning:** restore into a **new, empty** database. Running `--data-only` against a
> database that already holds rows will fail on primary-key conflicts, and running a
> full restore over live data can overwrite it. Never run `prisma migrate reset`
> against an instance holding real data.

---

## Building a Production Version
```bash
npm run build
npm run start
```

## Supported File Types
- **Images:** PNG, JPEG, WEBP (routed to the vision model). Accepted only as data URLs
  produced by `/api/upload`; remote image URLs are rejected so the backend cannot be
  induced to fetch arbitrary hosts.
- **Documents:** PDF (text extracted).
- **Code/Text:** TXT, MD, JSON, TS, TSX, JS, JSX, PY, JAVA, C, CPP, H, CSS, HTML, YML,
  YAML, SH.

Uploads are capped at 10MB and processed entirely in memory.
