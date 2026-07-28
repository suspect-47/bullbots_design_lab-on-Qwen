# syntax=docker/dockerfile:1
#
# BullBots Design Lab — container image for Alibaba Cloud
# Function Compute 3.0 (custom-container runtime) or ECS/ACK.
#
# Build from the REPO ROOT so the whole source tree is in context:
#   docker build -f deploy/Dockerfile -t bullbots-api:latest .
#
# Stage 1 builds the Vite frontend so the artifact is reproducible in CI and
# available for upload to Alibaba Cloud OSS static website hosting.
# The Fastify API does NOT serve dist/ itself (no @fastify/static in the
# dependency tree) — the frontend is deployed separately to OSS. See
# deploy/README.md, "Frontend → Alibaba Cloud OSS".

# ---------------------------------------------------------------- build stage
FROM node:20-alpine AS build
WORKDIR /app

# Install with the lockfile only first so this layer caches across code edits.
COPY package.json package-lock.json ./
RUN npm ci

# Build the SPA -> /app/dist
COPY . .
RUN npm run build

# --------------------------------------------------------------- deps (prod)
# A separate clean prod-only install keeps devDependencies (vite, vitest,
# tailwind) out of the runtime image.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ------------------------------------------------------------- runtime stage
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=9000

WORKDIR /app

# Non-root runtime user. node:20-alpine ships uid/gid 1000 as `node`; we create
# a dedicated `app` user so the image is explicit about who it runs as.
RUN addgroup -S app && adduser -S -G app app

COPY --from=deps  --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json  ./package.json
COPY --chown=app:app server        ./server
# The API imports pure domain/analysis modules straight out of src/lib
# (computeBot, fightVerdict, aggregate) — they are shared with the frontend, so
# src/ is a runtime dependency of the backend, not just build input.
COPY --chown=app:app src           ./src
# The built SPA travels with the image for convenience (`docker cp` it out to
# push to OSS); the API itself never reads it.
COPY --from=build --chown=app:app /app/dist ./dist

USER app

# Function Compute custom-container listens on the port declared in s.yaml.
EXPOSE 9000

# Fastify binds 0.0.0.0:$PORT (server/api/server.js).
CMD ["node", "server/api/server.js"]
