# syntax=docker/dockerfile:1.7
#
# The worker container (T1.11 DoD).
#
# Multi-stage so the runtime image carries no toolchain and no source. Built
# from the repo root — the worker depends on workspace packages, so the build
# context has to include them:
#
#   docker build -f apps/worker/Dockerfile -t orbit-worker .

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo

RUN corepack enable

# Only the manifests, so this layer is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/observability/package.json packages/observability/
COPY packages/db/package.json packages/db/
COPY packages/rbac/package.json packages/rbac/
COPY packages/auth/package.json packages/auth/
COPY packages/providers/package.json packages/providers/
COPY packages/storage/package.json packages/storage/
COPY packages/queue/package.json packages/queue/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/

# The Prisma client is generated code; it has to exist before tsc runs.
RUN pnpm --filter=@orbit/db exec prisma generate --schema prisma/schema.prisma

RUN pnpm exec tsc -b apps/worker

# Drop everything the runtime does not need — dev dependencies are roughly half
# the tree, and none of them run in production.
RUN pnpm prune --prod

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo

ENV NODE_ENV=production
# Read by `assertWorkerProcess`. Without it the process refuses to consume
# jobs — which is the point: a web image started by mistake stays a web image.
ENV ORBIT_ROLE=worker
# Distinguishes this container's log lines from the web app's.
ENV ORBIT_SERVICE=worker

# Never run as root.
RUN addgroup -S orbit && adduser -S orbit -G orbit

COPY --from=build --chown=orbit:orbit /repo/node_modules ./node_modules
COPY --from=build --chown=orbit:orbit /repo/packages ./packages
COPY --from=build --chown=orbit:orbit /repo/apps/worker ./apps/worker
COPY --from=build --chown=orbit:orbit /repo/package.json ./package.json

USER orbit

EXPOSE 3100

# The orchestrator's own probe should hit /health; this covers `docker run`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Direct node, not pnpm: pnpm would sit between the orchestrator's SIGTERM and
# the process that needs to handle it, and graceful drain depends on receiving
# that signal (see shutdown.ts).
CMD ["node", "apps/worker/dist/index.js"]
