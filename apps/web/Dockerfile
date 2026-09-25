# syntax=docker/dockerfile:1
# Web image (build context: the repo root): the static Vite build behind nginx, which also proxies
# /api to the API service (docker-compose.yml).
#   docker build -f apps/web/Dockerfile -t orbitworks-web .

# Base images are pinned by digest (Dependabot proposes updates, see .github/dependabot.yml).

# ---------------------------------------------------------------------------------------------
FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b AS build
# CI=true: the root `prepare` script skips git-hook installation.
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY scripts/prepare.mjs scripts/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@ow/web..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# Same origin only: the API is reached through nginx's /api proxy, which is what the image's CSP
# (connect-src 'self') allows. Cross-origin hosting is the Vercel build (vercel.json).
# Source maps ('hidden' in vite.config.ts) are for local debugging, not for the public site.
# nginx has no brotli module: precompress with gzip -9 once here, served by gzip_static.
RUN pnpm --filter @ow/web build && \
    find apps/web/dist -name '*.map' -delete && \
    find apps/web/dist -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) \
      -exec gzip -9 -k {} +

# ---------------------------------------------------------------------------------------------
# Unprivileged nginx: runs as uid 101 and listens on 8080, so no root and no capabilities needed.
FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:4714e0b1b2577eaa1a6131d07c958b67f0eb68e6d0521e90c6e5287db8cf0bc5 AS runtime
# Alpine publishes security fixes faster than the base image is rebuilt: apply them at build time.
USER 0
RUN apk upgrade --no-cache
USER 101
COPY apps/web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY apps/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/healthz"]
