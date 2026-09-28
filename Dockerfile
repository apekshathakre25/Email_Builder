# syntax=docker/dockerfile:1

###############################################################################
# Opterite
#
# One image, two roles. The web app (app.js) and the queue worker
# (workprocess/mailer.js) share the same code and dependencies, so they share
# an image and differ only by the command they are started with:
#
#   web:    node app.js                  (default CMD)
#   worker: node workprocess/mailer.js
#
# Scale the worker with `docker compose up --scale worker=N` rather than baking
# PM2 into the image — the container runtime already supplies the process
# supervision and restart behaviour ecosystem.config.js was doing.
###############################################################################

ARG NODE_VERSION=22.20.0

###############################################################################
# Stage 1 — production dependencies
###############################################################################
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app

# Copy only the manifests first so this layer is cached until they change.
COPY package.json package-lock.json ./

# `npm ci` installs the exact lockfile tree. --omit=dev drops devDependencies.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

###############################################################################
# Stage 2 — runtime
###############################################################################
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# procps: systeminformation (routes/system-health.js) shells out for CPU/mem
#         stats; without it currentLoad()/mem() fall back to empty values.
# curl:   used by the container HEALTHCHECK below.
RUN apt-get update \
 && apt-get install --no-install-recommends -y procps curl \
 && rm -rf /var/lib/apt/lists/*

# config/env.js reads NODE_ENV to decide production behaviour (secure cookies,
# strict secret validation, silenced console.log) and defaults PORT to 3000.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Dependencies first (changes rarely), then application code (changes often).
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node middleware ./middleware
COPY --chown=node:node models ./models
COPY --chown=node:node public ./public
COPY --chown=node:node routes ./routes
COPY --chown=node:node utils ./utils
COPY --chown=node:node views ./views
COPY --chown=node:node workprocess ./workprocess
COPY --chown=node:node app.js ./

# Writable runtime directories. These are mount points in compose; creating them
# here means the image also works standalone (uploads land in the container's
# writable layer instead of failing with EACCES).
RUN mkdir -p /app/uploads/sample /app/logs \
 && chown -R node:node /app/uploads /app/logs

# Drop root. The node image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 3000

# app.js serves /healthz without auth and with Cache-Control: no-store.
# start-period covers the initial Mongo/Redis connect.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# Signals: app.js installs SIGTERM/SIGINT handlers that drain connections, and
# exec-form CMD makes node PID 1 so it receives them directly. Run the
# container with --init (compose: `init: true`) so zombie children are reaped.
CMD ["node", "app.js"]
