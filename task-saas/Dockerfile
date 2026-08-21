# CodeMind production image.
#
# No secret is ever baked in: DATABASE_URL, AUTH_SECRET and every provider key are
# supplied at RUNTIME by the platform. .dockerignore keeps .env out of the build
# context so an accidental `COPY . .` cannot capture one.
#
# Migrations are deliberately NOT run here. The container starts the app only; run
# `npx prisma migrate deploy` as a separate deployment step so a rollout can never
# mutate the database as a side effect of a restart.

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

# Prisma Client must be generated before the build so route handlers type-check
# and the engine is traced into the standalone output.
RUN npx prisma generate
RUN npm run build

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
# against this exact build (e.g. `docker compose run --rm app npx prisma migrate deploy`).
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
