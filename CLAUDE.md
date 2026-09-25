# CLAUDE.md — Orbitworks Pass Explorer

Map-centric explorer for simulated satellite passes (10 satellites × 1 week). The brief is in
`docs/CHALLENGE.md` and decisions are in `docs/DECISIONS.md`. **Performance is the first design
criterion**, followed by a professional look and self-explanatory UX.

## Stack & layout

| Path              | What                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | `@ow/shared`: zod API contract + types, spherical geo math, solar position, binary track codec. Pure, no I/O.                                                       |
| `apps/api`        | `@ow/api`: Fastify 5 + DuckDB (`@duckdb/node-api`; numeric candidate filter, geometry in typed arrays — see ADR-003). REST under `/api/v1`, OpenAPI at `/api/docs`. |
| `apps/web`        | `@ow/web`: React 19 + Vite, MapLibre GL (OpenFreeMap vector tiles) + deck.gl, Zustand, TanStack Query, CSS Modules.                                                 |
| `data/`           | Immutable input dataset (gzipped GeoJSON). Never edit.                                                                                                              |
| `.claude/`        | Harness: hooks (guardrails), review agents, commands. Changes go through `/review` + `tests/harness`.                                                               |
| `tests/harness`   | Unit and end-to-end tests of the harness guardrails.                                                                                                                |

Workspace packages consume `@ow/shared` **source** through the `@ow/source` export condition (dev and
tests) and `dist/` in production.

## Commands

```bash
pnpm install          # also installs git hooks (lefthook)
pnpm seed             # build apps/api/data/ (tracks.duckdb + precompressed track artifacts) from data/*.json.gz
pnpm dev              # API :3000 + web :5173 (proxy /api)
pnpm verify           # FULL gate: format, lint, secrets, types, tests+coverage, build, size, e2e
pnpm verify:fast      # same without build/size/e2e
pnpm test             # unit + integration (all packages) + harness tests
pnpm e2e              # Playwright against the production build
pnpm perf             # API latency bench + Lighthouse budgets (needs build + seed; CI `perf` job)
docker compose up --build   # production-like stack on http://localhost:8080
```

## Conventions

- TypeScript strict everywhere. No `any`, and no `as` casts on external data: validate with the
  shared zod schemas instead.
- **One source of truth for the API contract**: `packages/shared/src/schemas.ts`. The API validates
  with it and the web app types responses from it.
- **Time**: every timestamp is UTC. ISO-8601 strings on the wire, epoch **seconds** inside the codec
  and the GPU, and epoch ms only at `Date` boundaries. Label UI times "UTC".
- **Units**: suffix names with them: `radiusKm`, `durationS`, `altitudeKm`, `elevationDeg`.
- **Geo**: longitudes are normalized to [-180, 180) at API boundaries. Handle the antimeridian and the
  poles explicitly, and test both.
- **SQL**: parameterized statements only. Never interpolate request data into SQL.
- **Web hot path**: timeline and satellite filters change deck.gl layer props only. No refetch, no
  rebuilt typed arrays, no per-frame React re-render of large trees (use store selectors or refs).
- **Comments** explain _why_. Name constants instead of using magic numbers.
- Commits use Conventional Commits with scopes from `commitlint.config.js`. One branch and PR per phase.

## Definition of Done (every change)

1. Unit tests for all new logic (Vitest), including edge cases (bounds, antimeridian, empty results,
   invalid input).
2. **Every user-facing feature has a Playwright E2E test** in `apps/web/e2e/`.
3. `pnpm verify` is green:
   - format, eslint (including sonarjs code-smell and security rules), stylelint, secretlint,
   - typecheck,
   - coverage thresholds (shared ≥ 95 %, api ≥ 90 %, web logic ≥ 85 %),
   - build, size budgets, E2E.
4. `/review` run: all four agents (code, security, QA, performance) and no open Critical/High findings.
5. Docs are updated when behaviour or decisions change (`README.md`, `docs/DECISIONS.md`).

Never weaken a guardrail to get green: don't disable rules without a written reason, lower
thresholds, skip tests, or use `--no-verify`. Fix the root cause.

## Performance budgets

| What                               | Budget                 |
| ---------------------------------- | ---------------------- |
| Tracks payload (brotli)            | ≤ 600 KB               |
| Cached `/tracks` p95               | < 5 ms                 |
| `/accesses` p95 (1 week, 2500 km)  | < 60 ms                |
| App JS chunk (gzip)                | ≤ 80 KB                |
| Total JS (gzip)                    | ≤ 750 KB               |
| Timeline scrub / satellite toggle  | **0** network requests |
| Lighthouse FCP / LCP / Speed Index | ≤ 1 s / 2 s / 2.4 s    |
| Lighthouse CLS / TBT               | ≤ 0.05 / 4 s           |

Lighthouse gates the median of 5 desktop runs per metric; the overall score is reported, not gated
(WebGL start-up inside MapLibre/deck.gl dominates TBT — ADR-010). Speed Index and TBT limits are set
from the CI runner (software WebGL), where the gate runs.

## Testing matrix (keep in sync)

| Feature                                                      | Unit / integration                                                     | E2E                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Geo math, solar position, codec                              | `packages/shared/src/*.test.ts`                                        | —                                                                                |
| Seed + `/dataset` `/tracks` `/accesses` `/healthz` `/readyz` | `apps/api/test/**` (Fastify `inject`, fixture DB)                      | —                                                                                |
| Track rendering + satellite filter                           | `state/store.test.ts`, `map/layers.test.ts`, `map/trackChunks.test.ts` | `e2e/tracks.spec.ts`                                                             |
| Timeline (brush, presets, play, zero API requests)           | `features/timeline/*.test.ts`, playback loop in `hooks.test.tsx`       | `e2e/timeline.spec.ts`                                                           |
| Track hover tooltip                                          | `map/trackQueries.test.ts` (nearest point)                             | `e2e/tooltip.spec.ts`                                                            |
| Accesses (pin, radius, dates, daylight, table, sync, CSV)    | `features/accesses/*.test.ts`                                          | `e2e/accesses.spec.ts`                                                           |
| Globe / flat projection                                      | `state/store.test.ts`                                                  | `e2e/tracks.spec.ts`, `e2e/url-state.spec.ts`                                    |
| URL state / shareable links                                  | `state/url.test.ts`                                                    | `e2e/url-state.spec.ts`                                                          |
| Error and empty states, basemap fallback                     | component tests, `tracks/fetchTracks.test.ts`                          | `e2e/resilience.spec.ts`                                                         |
| Help dialog, first-run hint, keyboard (Space, ?)             | component + `hooks.test.tsx`                                           | `e2e/onboarding.spec.ts`                                                         |
| Docker images, compose stack, deploy config (ADR-011)        | `scripts/securityHeaders.test.mjs` (nginx vs Vercel headers)           | `scripts/docker-smoke.sh`, `e2e/smoke` (CI `docker` job; live site after deploy) |
| Performance budgets (ADR-010)                                | `api/src/perf/*.test.ts`, `web/scripts/*.test.mjs`                     | `pnpm perf` (CI `perf`)                                                          |
