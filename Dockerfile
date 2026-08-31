# syntax=docker/dockerfile:1
#
# Linux container image. The main thing this buys over a bare install is that
# better-sqlite3's prebuilt binary always matches the runtime -- the step most
# likely to fail on a Windows host.
#
# UNVERIFIED: written without a running Docker daemon to build against.

# ---- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve npm.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run typecheck && npm run build

# Re-resolve without dev dependencies for the runtime layer. Same base image,
# so better-sqlite3's compiled binary stays ABI-compatible when copied.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so `docker stop` reaches the
# scheduler's shutdown handler instead of being killed after the grace period.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production TZ=Asia/Kolkata

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The ledger lives on a volume. Losing it does not lose data -- COSEC is
# re-readable -- but it does lose the record of what was already delivered,
# which would re-send the whole sweep window.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node

ENV DB_PATH=/data/sync.db \
    LOCK_PATH=/data/sync.lock

# Reports config problems by exiting non-zero at startup rather than at 00:30.
HEALTHCHECK --interval=5m --timeout=30s --start-period=20s \
  CMD node dist/cli.js status > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
