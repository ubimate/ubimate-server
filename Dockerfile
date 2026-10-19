# Ubimate Multi-Target Dockerfile
# Supports multiple deployment targets via DOCKER_BUILDKIT=1 docker build --target=TARGET
# 
# Targets:
#   - api:         Node.js API server only (production)
#   - web:         Nginx serving built web app (production)
#   - mobile-web:  Nginx serving built mobile-web app (production)
#   - server:      Node.js API + admin panel (self-hosted)
#   - unified:     Single container with API, web, admin (docker-compose dev)

# ============================================================================
# SHARED BUILD STAGE - compiles all workspace packages
# ============================================================================
FROM node:20-alpine AS build-shared

RUN npm install -g pnpm@8.9.2
RUN apk add --no-cache curl

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/core/package.json packages/core/
COPY packages/editor/package.json packages/editor/
COPY packages/client/package.json packages/client/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile-web/package.json apps/mobile-web/

RUN pnpm install --frozen-lockfile

# Copy all source
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/web/ apps/web/
# The first run's starting pages (apps/web/src/lib/firstRun.ts imports them).
COPY userdocs/ userdocs/
COPY apps/admin/ apps/admin/
COPY apps/mobile-web/ apps/mobile-web/
COPY scripts/ scripts/

# Build shared packages (all targets need these)
RUN pnpm --filter @ubimate/utils build
RUN pnpm --filter @ubimate/core build
RUN pnpm --filter @ubimate/client build
RUN pnpm --filter @ubimate/crypto build
RUN pnpm --filter @ubimate/auth-core build

# ============================================================================
# API TARGET - Node.js API server only
# ============================================================================
FROM node:20-alpine AS api

RUN npm install -g pnpm@8.9.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/

RUN pnpm --filter @ubimate/utils build
RUN pnpm --filter @ubimate/core build
RUN pnpm --filter api build

# Production dependencies only
RUN pnpm prune --prod

ENV NODE_ENV=production
EXPOSE 3001

# Swarm (and therefore CapRover) only restarts a task when its process exits.
# Without this, a wedged-but-alive process keeps serving traffic forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT:-3001}/api/health" || exit 1

CMD ["node", "apps/api/dist/index.js"]

# ============================================================================
# WEB TARGET - Nginx serving built web frontend
# ============================================================================
FROM node:20-alpine AS web-builder

RUN npm install -g pnpm@8.9.2
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/editor/package.json packages/editor/
COPY packages/client/package.json packages/client/
COPY packages/notion-import/package.json packages/notion-import/
COPY packages/persistent-format/package.json packages/persistent-format/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
# The first run's starting pages (apps/web/src/lib/firstRun.ts imports them).
COPY userdocs/ userdocs/
COPY scripts/ scripts/

RUN pnpm --filter @ubimate/client build

# Build-time env vars
# Defaults target ubimate.app (CapRover production)
# Override via docker build --build-arg
ARG VITE_API_URL=https://ubimate.app
ARG VITE_HOCUSPOCUS_URL=wss://ubimate.app/yjs

RUN pnpm vendor:drawio
RUN pnpm --filter web build

FROM nginx:alpine AS web

COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf

# Internal hostname of the API container (CapRover default)
# Override for docker-compose/Coolify: "api"
ARG API_SERVICE_HOST=srv-captain--ubimate-app
RUN sed -i "s/__API_HOST__/$API_SERVICE_HOST/g" /etc/nginx/conf.d/default.conf

EXPOSE 80

# ============================================================================
# MOBILE-WEB TARGET - Nginx serving built mobile-web frontend
# ============================================================================
FROM node:20-alpine AS mobile-web-builder

RUN npm install -g pnpm@8.9.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/editor/package.json packages/editor/
COPY packages/client/package.json packages/client/
COPY packages/notion-import/package.json packages/notion-import/
COPY packages/persistent-format/package.json packages/persistent-format/
COPY apps/web/package.json apps/web/
COPY apps/mobile-web/package.json apps/mobile-web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
# The first run's starting pages (apps/web/src/lib/firstRun.ts imports them).
COPY userdocs/ userdocs/
COPY apps/mobile-web/ apps/mobile-web/

# Build-time env vars
# Standalone mobile web image (self-hosting). ubimate.app does not use it: the
# unified image serves the mobile app at /m. Set these to this image's own origin,
# since its nginx proxies /api and /yjs.
ARG VITE_API_URL=https://m.ubimate.app
ARG VITE_HOCUSPOCUS_URL=wss://m.ubimate.app/yjs

RUN VITE_API_URL=$VITE_API_URL VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL \
    pnpm --filter @ubimate/client build

RUN VITE_API_URL=$VITE_API_URL VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL \
    pnpm --filter mobile-web build

FROM nginx:alpine AS mobile-web

COPY --from=mobile-web-builder /app/apps/mobile-web/dist /usr/share/nginx/html
COPY deploy/nginx-mobile-web.conf /etc/nginx/conf.d/default.conf

ARG API_SERVICE_HOST=srv-captain--ubimate-app
RUN sed -i "s/__API_HOST__/$API_SERVICE_HOST/g" /etc/nginx/conf.d/default.conf

EXPOSE 80

# ============================================================================
# SERVER TARGET - API + admin (self-hosted)
# ============================================================================
FROM node:20-alpine AS server

RUN npm install -g pnpm@8.9.2
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/admin/ apps/admin/

RUN pnpm --filter @ubimate/utils build
RUN pnpm --filter @ubimate/core build

# Build admin at /admin/ subpath
RUN VITE_BASE_PATH=/admin/ pnpm --filter admin build

# Build API
RUN pnpm --filter api build

# Production dependencies only
RUN pnpm prune --prod

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]

# ============================================================================
# UNIFIED TARGET - API + web + admin + mobile web in one container (CapRover ubimate-app, docker-compose)
# ============================================================================
FROM node:20-alpine AS unified-builder

RUN npm install -g pnpm@8.9.2
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/core/package.json packages/core/
COPY packages/editor/package.json packages/editor/
COPY packages/client/package.json packages/client/
COPY packages/notion-import/package.json packages/notion-import/
COPY packages/persistent-format/package.json packages/persistent-format/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile-web/package.json apps/mobile-web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/web/ apps/web/
# The first run's starting pages (apps/web/src/lib/firstRun.ts imports them).
COPY userdocs/ userdocs/
COPY apps/admin/ apps/admin/
COPY apps/mobile-web/ apps/mobile-web/
COPY scripts/ scripts/

# Build packages
RUN pnpm --filter @ubimate/utils build
RUN pnpm --filter @ubimate/core build
RUN pnpm --filter @ubimate/client build

# Build web (Vite). Defaults target production; docker-compose passes localhost.
ARG VITE_API_URL=https://ubimate.app
ARG VITE_HOCUSPOCUS_URL=wss://ubimate.app/yjs

RUN pnpm vendor:drawio
RUN pnpm --filter web build

# Build admin at /admin/
RUN VITE_BASE_PATH=/admin/ pnpm --filter admin build

# Build the mobile web app at /m/ (same origin as the API, so the same VITE_API_URL)
RUN VITE_BASE_PATH=/m/ pnpm --filter mobile-web build

# Build API
RUN pnpm --filter api build

# Prune dev deps
RUN pnpm prune --prod

# Node, not nginx: the API serves the web app, the admin app (/admin) and the
# mobile web app (/m) itself in production (apps/api/src/index.ts, from the dist
# folders next to its own), and the Yjs relay on the same port. CapRover's container
# port and docker-compose's mapping are 3001.
FROM node:20-alpine AS unified

WORKDIR /app

COPY --from=unified-builder /app/node_modules          node_modules/
COPY --from=unified-builder /app/packages              packages/
COPY --from=unified-builder /app/apps/api/dist         apps/api/dist/
COPY --from=unified-builder /app/apps/api/node_modules apps/api/node_modules/
COPY --from=unified-builder /app/apps/api/package.json apps/api/package.json
COPY --from=unified-builder /app/apps/web/dist         apps/web/dist/
COPY --from=unified-builder /app/apps/admin/dist       apps/admin/dist/
COPY --from=unified-builder /app/apps/mobile-web/dist  apps/mobile-web/dist/

ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT:-3001}/api/health" || exit 1
CMD ["node", "apps/api/dist/index.js"]
