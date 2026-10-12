# syntax=docker/dockerfile:1.7

# Node and Alpine are pinned together: the runtime stage copies the Node binary
# from the node image onto the same Alpine release.
ARG NODE_IMAGE=node:24-alpine3.24
ARG ALPINE_IMAGE=alpine:3.24

# ---------------------------------------------------------------------------
# 1) Build everything (client types, web UI, server bundle)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# 2) Production dependencies of the server only
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY web/package.json web/
# Prune what is never loaded at runtime (~35 MB): source maps, docs, and the unused sql.js builds
# (just-bash's sqlite3 only loads sql-wasm.js + sql-wasm.wasm).
RUN npm ci --omit=dev --no-audit --no-fund --workspace @agentcave/server --include-workspace-root=false \
  && mkdir -p server/node_modules \
  && find node_modules server/node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete \
  && find node_modules/sql.js/dist -type f ! -name 'sql-wasm.js' ! -name 'sql-wasm.wasm' -delete \
  && npm cache clean --force

# ---------------------------------------------------------------------------
# 3) Runtime: plain Alpine + the Node binary (no npm/yarn, ~25 MB smaller)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS node

FROM ${ALPINE_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++ libgcc tini \
  && addgroup -S cave && adduser -S -G cave -h /home/cave cave \
  && mkdir -p /data && chown cave:cave /data

WORKDIR /app
ENV NODE_ENV=production \
    PORT=7420 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    LOG_LEVEL=info

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

USER cave
VOLUME ["/data"]
EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" > /dev/null || exit 1

# tini forwards SIGTERM so running cycles are left `running` and restart on the next boot.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
