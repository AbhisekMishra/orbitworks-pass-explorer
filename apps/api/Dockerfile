# syntax=docker/dockerfile:1
# API image (build context: the repo root). The database is seeded at build time, so the image is
# immutable and starts in about a second: the container only opens a read-only DuckDB file.
#   docker build -f apps/api/Dockerfile -t orbitworks-api .

# Base images are pinned by digest (Dependabot proposes updates, see .github/dependabot.yml).

# ---------------------------------------------------------------------------------------------
FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b AS deps
# CI=true: the root `prepare` script skips git-hook installation.
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
# Manifests first: the dependency layer is reused until a lockfile or manifest changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY scripts/prepare.mjs scripts/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# Only the target platform's DuckDB bindings (~70 MB each): this platform, glibc (Debian 13).
RUN printf 'supportedArchitectures:\n  os: [current]\n  cpu: [current]\n  libc: [glibc]\n' >> pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile --filter "@ow/api..."

# ---------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ow/shared build && pnpm --filter @ow/api build
# Seed from the immutable input dataset into apps/api/data (tracks.duckdb + track artifacts).
COPY data data
RUN node apps/api/dist/seed.js
# Production dependencies only, with @ow/shared as a real package (its dist/).
RUN pnpm deploy --filter @ow/api --prod --legacy /out

# ---------------------------------------------------------------------------------------------
# Distroless: no shell or package manager, runs as uid 65532. Debian (glibc) because DuckDB's
# prebuilt bindings target glibc, not musl.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:5ef534d3db0ac0c43bee379af4ae49cfbfc0ef38a46c94c52d87c68f32f34d8a AS runtime
WORKDIR /app
# package.json: "type": "module", so dist/server.js loads as ESM.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
# Owned by root and not writable by the runtime user: DuckDB opens the file READ_ONLY.
COPY --from=build /repo/apps/api/data ./data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
# Distroless 'nonroot' (numeric, so runtimes can verify it is not root without /etc/passwd).
USER 65532:65532
# No curl in distroless: probe /readyz with the image's own Node.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["--enable-source-maps", "dist/server.js"]
