# CodeMind production image.
#
# No secret is ever baked in: DATABASE_URL, AUTH_SECRET and every provider key are
# supplied at RUNTIME by the platform. .dockerignore keeps .env out of the build
# context so an accidental `COPY . .` cannot capture one.
#
# Migrations are NOT run by CMD. The container starts the app only, so a restart can
# never mutate the database as a side effect — that property is deliberate and is why
# `migrate deploy` is not in the entrypoint.
#
# What the runner DOES carry is the Prisma CLI and the migration files, so a platform
# pre-deploy hook (render.yaml `preDeployCommand`) can run `migrate deploy` inside this
# exact image, once per deploy, before the new instance serves traffic. Previously the
# CLI was pruned from the runtime image and migrations had to be applied by hand from a
# developer machine — which is a step that gets forgotten, and cannot be done at all by
# someone without that machine.

FROM node:22-alpine AS base

# ---- deps -------------------------------------------------------------------
FROM base AS deps
# openssl is required by Prisma's query engine on Alpine (musl).
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci

# ---- builder ----------------------------------------------------------------
FROM base AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# Opts next.config.js into `output: "standalone"`, which produces the server.js this
# image runs. It is set here rather than unconditionally in the config because Vercel
# builds the same repo through its own output pipeline and must NOT get standalone.
ENV DOCKER_BUILD=1

# Prisma Client must be generated before the build so route handlers type-check
# and the engine is traced into the standalone output.
RUN npx prisma generate
RUN npm run build

# ---- migrate CLI ------------------------------------------------------------
# The Prisma CLI is a devDependency, and Next's standalone output prunes it. Copying
# node_modules/prisma out of the builder does NOT work: the CLI has a 33-package
# dependency closure (@prisma/debug, @prisma/get-platform, c12, effect, giget and the
# rest), and hand-listing those in COPY lines would silently rot on every Prisma
# upgrade. Measured, not assumed — the first attempt at this copied `prisma` and
# `@prisma/engines` alone and died on `Cannot find module '@prisma/debug'`.
#
# So npm resolves the closure instead, at BUILD time. The original objection to a
# pre-deploy step was that it would fetch from npm on every DEPLOY, as a non-root user;
# fetching once during the build, where network and root are both available, answers
# that objection rather than ignoring it.
#
# The version is read from the app's package.json so this cannot drift from the CLI the
# migrations were authored with.
FROM base AS migrate-cli
RUN apk add --no-cache libc6-compat openssl
WORKDIR /opt/prisma
COPY package.json ./app-package.json
RUN PRISMA_VERSION="$(node -p "require('./app-package.json').devDependencies.prisma")" && echo '{"name":"codemind-migrate-cli","private":true}' > package.json && npm install --omit=optional --no-audit --no-fund "prisma@${PRISMA_VERSION}" && rm app-package.json

# ---- runner -----------------------------------------------------------------
FROM base AS runner
# The runner executes Prisma queries, so it needs openssl too. Without this the
# query engine fails to load at runtime with a libssl error.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Schema and migrations ship with the image so `prisma migrate deploy` can be run
# against this exact build (e.g. `docker compose run --rm app npm run migrate:deploy`).
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# The Prisma CLI, installed by the migrate-cli stage below.
#
# Kept in /opt rather than merged into ./node_modules on purpose: the standalone output
# copied above BRINGS ITS OWN ./node_modules, containing exactly the modules Next traced
# as reachable from the server. Overlaying anything on top of that risks replacing a
# traced module with a different copy, and the failure would appear at runtime in the
# app rather than here.
COPY --from=migrate-cli /opt/prisma /opt/prisma

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
