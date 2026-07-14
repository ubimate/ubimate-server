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
CMD ["node", "apps/api/dist/index.js"]

# ============================================================================
# WEB TARGET - Nginx serving built web frontend
# ============================================================================
FROM node:20-alpine AS web-builder

RUN npm install -g pnpm@8.9.2
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/crypto/package.json packages/crypto/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/editor/package.json packages/editor/
COPY packages/client/package.json packages/client/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
COPY scripts/ scripts/

RUN pnpm --filter @ubimate/client build

# Build-time env vars
# Defaults target app.ubimate.com (CapRover production)
# Override via docker build --build-arg
ARG VITE_API_URL=https://app.ubimate.com
ARG VITE_HOCUSPOCUS_URL=wss://app.ubimate.com/yjs

RUN pnpm vendor:drawio
RUN pnpm --filter web build

FROM nginx:alpine AS web

COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf

# Internal hostname of the API container (CapRover default)
# Override for docker-compose/Coolify: "api"
ARG API_SERVICE_HOST=srv-captain--ubimate-api
RUN sed -i "s/__API_HOST__/$API_SERVICE_HOST/g" /etc/nginx/conf.d/default.conf

EXPOSE 80

# ============================================================================
# MOBILE-WEB TARGET - Nginx serving built mobile-web frontend
# ============================================================================
FROM node:20-alpine AS mobile-web-builder

RUN npm install -g pnpm@8.9.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json packages/types/
COPY packages/crypto/package.json packages/crypto/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/editor/package.json packages/editor/
COPY packages/client/package.json packages/client/
COPY apps/web/package.json apps/web/
COPY apps/mobile-web/package.json apps/mobile-web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
COPY apps/mobile-web/ apps/mobile-web/

# Build-time env vars
# Defaults target m.app.ubimate.com (CapRover production)
# Mobile app proxies /api and /yjs through its own nginx, so origins must match
ARG VITE_API_URL=https://m.app.ubimate.com
ARG VITE_HOCUSPOCUS_URL=wss://m.app.ubimate.com/yjs

RUN VITE_API_URL=$VITE_API_URL VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL \
    pnpm --filter @ubimate/client build

RUN VITE_API_URL=$VITE_API_URL VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL \
    pnpm --filter mobile-web build

FROM nginx:alpine AS mobile-web

COPY --from=mobile-web-builder /app/apps/mobile-web/dist /usr/share/nginx/html
COPY deploy/nginx-mobile-web.conf /etc/nginx/conf.d/default.conf

ARG API_SERVICE_HOST=srv-captain--ubimate-api
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
# UNIFIED TARGET - API + web + admin (single container, docker-compose dev)
# ============================================================================
FROM node:20-alpine AS unified-builder

RUN npm install -g pnpm@8.9.2
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/web/ apps/web/
COPY apps/admin/ apps/admin/
COPY scripts/ scripts/

# Build packages
RUN pnpm --filter @ubimate/utils build
RUN pnpm --filter @ubimate/core build
RUN pnpm --filter @ubimate/client build

# Build web (Vite)
ARG VITE_API_URL=http://localhost:3001
ARG VITE_HOCUSPOCUS_URL=ws://localhost:3001/yjs

RUN pnpm vendor:drawio
RUN pnpm --filter web build

# Build admin at /admin/
RUN VITE_BASE_PATH=/admin/ pnpm --filter admin build

# Build API
RUN pnpm --filter api build

# Prune dev deps
RUN pnpm prune --prod

FROM nginx:alpine AS unified

WORKDIR /app

# Copy Node artifacts (for potential future use or multi-process setup)
COPY --from=unified-builder /app/node_modules node_modules/
COPY --from=unified-builder /app/packages packages/
COPY --from=unified-builder /app/apps/api/dist apps/api/dist/
COPY --from=unified-builder /app/apps/api/node_modules apps/api/node_modules/
COPY --from=unified-builder /app/apps/api/package.json apps/api/package.json

# Copy web artifacts
COPY --from=unified-builder /app/apps/web/dist /usr/share/nginx/html/

# Copy admin artifacts (served at /admin/)
COPY --from=unified-builder /app/apps/admin/dist /usr/share/nginx/html/admin/

# Nginx config (proxies /api and /yjs to the API container)
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf

RUN npm install -g pnpm@8.9.2
ENV NODE_ENV=production

EXPOSE 80 3001

# For unified, use a simple entrypoint that serves nginx
# In production use separate containers for api + web
CMD ["nginx", "-g", "daemon off;"]
