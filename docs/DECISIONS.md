# Architecture decisions

Each record states the context, the decision, and the evidence behind it. All numbers were
measured on the real dataset (10 satellites × 1 week, 100,810 one-minute segments, 604,870
unique vertices) on a laptop (Windows 11, Node 22). The build history is in the Git log and PRs.

---

## ADR-001: TypeScript end to end (Node API, React web)

**Context.** The brief allows Node or Python for the API and asks for TypeScript over JavaScript.

**Decision.** Use TypeScript across the whole stack: a pnpm monorepo with `packages/shared`,
`apps/api` and `apps/web`.

**Why.**

- **One contract.** The API validates requests with the same zod schemas the web app uses to type
  responses (`packages/shared/src/schemas.ts`), so the two cannot drift apart.
- **Shared code.** The spherical geometry and the binary codec run unchanged on both sides.
- **No event-loop blocking.** DuckDB queries run on libuv worker threads. The CPU-bound pass
  geometry is bounded: 31 ms p95 at the worst case, measured below.

---

## ADR-002: One binary download, filtered on the GPU

**Context.** The brief wants the map to refresh "quasi instantly" when filters change. The week is
59 MB of GeoJSON, so refetching GeoJSON on every filter change cannot be instant.

**Decision.** The web app downloads the whole week once, in a custom compact format (OWT1,
`packages/shared/src/trackCodec.ts`), then filters by time and satellite on the GPU. That means
deck.gl layer uniforms and visibility, with no network request and no re-upload.

**OWT1 in brief.**

- Timestamps are implicit (fixed 10 s step).
- lon/lat are quantized to 1e-4° (≈ 11 m) and altitude to 100 m.
- Values are stored as zig-zag varint second differences.

**Measured sizes.**

| Encoding              | Size        | vs GeoJSON |
| --------------------- | ----------- | ---------- |
| GeoJSON               | 59 MB       | 1×         |
| OWT1 raw              | 2.1 MB      | 28×        |
| OWT1 gzip             | 0.88 MB     | 67×        |
| **OWT1 brotli (q11)** | **0.52 MB** | **113×**   |

**Speed.** Encoding takes ~65 ms, once, at seed time. Decoding takes ~16 ms, in a Web Worker.

**Why not the alternatives.**

- **Float32 lon/lat:** 4.8 MB raw and 3.1 MB brotli, because float bits barely compress.
- **Altitude at 1 m:** 611 KB brotli, over the 600 KB budget. At 100 m it is 524 KB, and altitude is
  only displayed to 0.1 km.
- **Unwrapped longitudes in the output:** they drift to −41,021° over the week, which costs ~217 m of
  precision once cast to Float32 on the GPU. Decoded longitudes are therefore wrapped to [−180, 180).

**Compression.** Only brotli quality 11 fits the budget (q4 gives 763 KB), but q11 costs ~2.7 s of
CPU, so it runs once at seed time and never on the request path.
The API precompresses at seed time and serves the result from memory with a strong ETag, weak- and
list-aware `If-None-Match`, and `Vary: Accept-Encoding`.

---

## ADR-003: DuckDB as the candidate filter, exact geometry in typed arrays

**Context.** The brief suggests DuckDB and its spatial extension. The access query must find every
arc of track inside a circle of up to 2,500 km, with exact entry and exit times.

**Decision.**

1. **Seeding.** DuckDB parses the gzipped GeoJSON natively with `read_json` and an explicit schema,
   so the 59 MB file never goes through `JSON.parse`. Seeding takes ~5 s. Each segment is stored
   with:
   - a numeric bounding box (antimeridian-crossing segments get a full-width box);
   - its centre as a unit vector;
   - `reach_rad`, the largest angle from the centre to any vertex;
   - `seg_id`, numbering segments by satellite, then time.
2. **Candidate search (SQL).** A vectorised scan over plain numeric predicates: bounding-box
   overlap, a spherical-cap test `acos(c·p) ≤ r + reach`, time window and satellites. It returns
   `seg_id`s only.
3. **Exact geometry (Node).** It runs on typed arrays loaded once at boot: unit vectors,
   ~33 MB, loaded in ~0.35 s.

**Why the R-tree is not used (measured).**

| Candidate search                    | 400 km (Dubai) | 400 km, lat 80° | 2500 km, lat 50° | 2500 km, lat 75° |
| ----------------------------------- | -------------- | --------------- | ---------------- | ---------------- |
| Spatial R-tree (`ST_Intersects`)    | **1.0 ms**     | 4.0 ms          | 13.1 ms          | 28.1 ms          |
| R-tree in a CTE + cap filter        | 2.6 ms         | 15.6 ms         | 54.7 ms          | 31.3 ms          |
| **Numeric bbox + cap (vectorised)** | 2.6 ms         | **2.9 ms**      | **3.4 ms**       | **3.6 ms**       |

- **Predictable cost.** The R-tree only wins on small circles, by 1.6 ms. For large boxes DuckDB's
  optimiser drops the index and evaluates `ST_Intersects` on every geometry (28 ms). Adding any
  further predicate to an index query also disables the index. The plain scan costs ~3 ms whatever
  the radius or latitude.
- **Simpler operations.** With the spatial extension gone, seeding and tests need no network (no
  extension download), and the runtime has no extension directory to configure or lock down.

**Why typed arrays instead of reading coordinates from DuckDB.**

- Converting DuckDB's nested coordinate lists into JS objects costs ~130 ms for 6,000 segments.
- Fetching the matching ids costs ~15 ms.

The pass engine (`apps/api/src/domain/passes.ts`) therefore works on flat `Float64Array`s. For each
arc it runs, in order:

1. an O(1) dot-product rejection;
2. a no-trigonometry acceptance when the whole arc is inside (a cap smaller than a hemisphere is
   convex);
3. analytic entry and exit points (`intersectArcWithCap`) for the ~2 boundary arcs of each pass;
4. a closed-form closest approach.

**Correctness evidence.**

- **Brute force:** a property test compares entry, exit and closest approach against 0.1 s sampling
  on random tracks, including near-polar tracks and radii up to 2,500 km.
- **Lossless filtering:** an integration test checks that DuckDB-filtered results equal a scan of
  every segment, on the antimeridian, at both poles, and at radii of 10, 400 and 2,500 km.
- **Real data:** the computed passes for a point in the UAE match `Inspiration.png` (06:58 YAM20,
  10:07 YAM25).

---

## ADR-004: Response size is a latency budget

**Context.** At HTTP level, including serialization and compression, `/accesses` p95 was
78–92 ms at 2,500 km. That is over the 60 ms budget. Each pass carried its clipped path, which was
about 93 % of the compressed bytes.

**Decision.**

- **Paths are opt-in.** Pass `path` is only included with `includePath=true`. The web app already
  holds every track (ADR-002), so it rebuilds any pass's path from its satellite and time span.
- **Cheaper compression.** Dynamic brotli uses quality 4 instead of 5: half the CPU for under 1 %
  more bytes.
- **Filter before building objects.** Passes are filtered (daylight) and sorted on plain numbers
  before full `Pass` objects are built.
- **Bounded on-demand track work.** Tracks are served from the in-memory geometry, never from
  DuckDB rows. Filtered binary slices are limited to 24 h and GeoJSON to 6 h. Any filter that
  resolves to the whole dataset gets the precompressed artifact.

**Result (real socket, production config).**

| Case                                               | p50     | p95     |
| -------------------------------------------------- | ------- | ------- |
| 400 km                                             | 5.4 ms  | 7.2 ms  |
| 2,500 km, random points                            | 12.3 ms | 27.2 ms |
| 2,500 km, latitude 75° (1,064 passes, worst case)  | 28.3 ms | 30.6 ms |
| Same with `includePath=true` (opt-in, for GIS use) | 73.8 ms | 77.5 ms |

The opt-in path case is over the 60 ms budget. The web app never requests it.

---

## ADR-005: Security posture of a public, read-only API

**Decisions.**

- **Input validation.** Every input is validated with the shared zod contract:
  - numbers must be decimal (no silent `'' → 0`, no hex, no `Infinity`);
  - instants need an explicit UTC offset and must fall in 2000–2099;
  - windows are capped (GeoJSON ≤ 6 h, filtered binary ≤ 24 h, otherwise ≤ 31 days) and clamped
    to the dataset;
  - at most 64 satellite ids.
- **SQL.** SQL text is static; request values are bound parameters only.
- **Locked-down database.** DuckDB is opened `READ_ONLY`, auto-install and auto-load are off,
  external access is disabled and the configuration is locked. A test proves that `read_csv`,
  `COPY`, `CREATE`, `ATTACH`, `INSTALL` and `SET` are refused.
- **Rate limits.**
  - Per route: `/accesses` 120/min, `/tracks*` 60/min. Global limit: 600/min.
  - Health probes are exempt.
  - Only the configured number of proxy hops is trusted when reading `X-Forwarded-For`. Tests show
    a spoofed prefix cannot evade the limit.
- **HTTP hardening.** Helmet headers, an exact CORS origin allowlist (bare origins validated), and a
  1 KB body limit.
- **Request ids.** Upstream request ids are accepted only when well-formed.
- **Errors.** 5xx responses never contain internals, only a request id.
- **Consistent seeds.** The seed writes the database and the artifacts under pending names and
  renames them into place. The database records the artifact ETag, and the server refuses to boot
  on a mismatch. At boot it also decompresses the `.br` and `.gz` files and compares them with the
  raw stream, so a stale compressed file can never be served under a new ETag.

---

## ADR-006: Hosting — Vercel for the web app, Railway for the API

**Decision.**

- **Web app on Vercel.** It is a static Vite build on Vercel's CDN, with preview deploys per PR.
- **API on Railway.** It runs our Dockerfile as an always-on process, so there are no cold starts.
  The DuckDB file is baked into the image at build time.

**Why not Vercel serverless for the API.** The DuckDB native module and database file would have to
fit in a function bundle; every cold start would pay for opening DuckDB and loading ~33 MB of
geometry; and the brief's Docker deliverable would go unused.

**Networking.** The web app calls the API cross-origin (CORS allowlist) rather than through a Vercel
rewrite. Behind a rewrite, every user would reach the API from Vercel's egress IPs and share one
rate-limit bucket. Direct calls are simple GETs with no custom headers, so they need no preflight,
and Railway sees each real client IP (one trusted proxy hop).

---

## ADR-007: Guardrails first (Claude Code harness)

See [AI_USAGE.md](AI_USAGE.md) _(written in the documentation phase)_.

**Summary.**

- **Harness first.** Hooks, review agents, git hooks and CI were built before any feature.
- **Hooks.** Every edit is formatted and linted, including sonarjs code-smell and security rules.
  Dangerous commands and secrets are blocked.
- **Gates.** The agent cannot finish a turn while the tree is red.
- **Reviews.** Every phase gets a four-agent review (code, security, QA, performance) before merge.

**Effect.** The reviews and tests changed the design several times:

- **Bugs caught:** the float32 precision loss (ADR-002); a decoder that would allocate before
  validating; a content-negotiation bug that served 2 MB uncompressed; request-id sanitising that
  never ran.
- **Design changes:** the removal of the R-tree (ADR-003) and opt-in paths (ADR-004).

---

## ADR-008: Web rendering — GPU time filter, time chunks, nothing on the hot path

**Context.** The map must follow the timeline and the satellite toggles "quasi instantly". The
week is 605k vertices (10 satellites × 60,487).

**Decision.**

1. **Decode off the main thread.** A Web Worker downloads OWT1, decodes it and builds the GPU
   buffers, then transfers them without copying. The worker bundle is 2 KB gzip: the codec is
   zod-free on purpose.
2. **Time is a GPU uniform.** `TrackLayer` (a deck.gl `PathLayer` with per-vertex timestamps,
   the same technique as `TripsLayer`) discards fragments outside the window. Moving the window
   changes two uniforms: no re-upload and no re-tessellation.
3. **12 h chunks.** Each satellite's buffers are split into 12 h chunks. These are views, not
   copies, and each chunk is its own layer. Only chunks overlapping the window are `visible`, so
   vertex work follows the window length instead of the whole week. A 6 h window draws 10–20
   of about 150 chunks, roughly 7–15× fewer vertices. Hidden chunks get constant uniforms, so
   deck.gl's diff skips them.
4. **No React on the hot path.** The map controller subscribes to the Zustand store and pushes
   new layer props synchronously; deck.gl batches the redraw into its next frame. Only the small
   controls that display the window re-render.
5. **Downloads start before the map code.** The entry point starts the dataset and track
   requests, then lazily imports the app (MapLibre, deck.gl). The 0.5 MB of tracks downloads in
   parallel with the vendor JavaScript instead of after it.
6. **Geometry details.**
   - **Antimeridian.** Tracks are split at the antimeridian, with an interpolated vertex on each
     edge, so the flat map never draws a line across the world.
   - **Relative time.** GPU timestamps are seconds since the dataset epoch; epoch seconds lose
     ~2 minutes of precision in Float32.
   - **2 km lift.** Tracks are drawn 2 km above the ground. The straight segments between samples
     76 km apart would otherwise dip about 113 m below the globe surface and flicker.

**Evidence.**

- **Filtering.** Toggling satellites, presets, dragging and playing make zero API requests. The
  Playwright suite asserts this.
- **Software rendering.** In SwiftShader (the CI browser has no GPU), the full-week vertex load
  made the page unresponsive: 9 of 17 E2E tests timed out. With chunking, all pass.
- **Bundle.** App code is 17 KB gzip. Total JS is 638 KB (budget 750 KB), workers included:
  MapLibre 296 KB, deck.gl 222 KB and React 66 KB.

**MapLibre 6, served unbundled.**

- **Why 6.x.** MapLibre up to 6.4.0 has a sanitizer-bypass advisory, GHSA-jrc7-96c5-q579. It
  affects the attribution HTML that comes from the third-party style. It has no 5.x fix, so we use
  6.x.
- **deck.gl compatibility.** deck.gl 9.4's interleaved renderer still reads `map.transform`.
  MapLibre 6 keeps that object on its camera, so `mapController.ts` exposes it under the old name.
  It is a one-line, documented shim, and every E2E test exercises it.
- **Unbundled delivery.** MapLibre 6 is three ES modules (main, shared, worker), and the worker
  is found through a URL relative to the main module. Bundling breaks that URL. A separately
  bundled worker also duplicates the shared module, about 145 KB gzip. We therefore serve
  MapLibre's own files, unbundled, from a versioned `/vendor/maplibre-gl-<version>/` path. The
  worker then shares the cached shared module: about 110 KB less JavaScript per visit.

**Resilience.**

- **Basemap outage.** If OpenFreeMap is unreachable, the map switches to a plain local style.
  Tracks, tooltips and the timeline keep working, because deck.gl layers only attach once some
  style has loaded.
- **API errors.** They show a retry card; only transient errors (5xx, 429, network) are retried
  automatically.

---

## ADR-009: Accesses UI — one filter set, three synchronized views

**Context.** Function 2 of the brief asks for passes over a clicked point: a user-chosen radius
and date range, with the matching portions of track shown. The brief also asks for tables and
the map to stay in sync.

**Decision.**

- **One set of filters.** The pass list follows the satellites selected in the left panel, so
  the map and the list never disagree. The pin, radius, days and daylight filter live in the
  store and in the shareable link.
- **Satellites are filtered in the browser.** The API is always asked for every satellite, and the
  selection is applied on the client, with the stats recomputed by the same shared function the
  API uses (`computePassStats` in `@ow/shared`). A satellite toggle therefore costs no request,
  which keeps the zero-network budget for toggles. Asking for all ten satellites costs little: a
  week at the largest radius is a few hundred passes, tens of kilobytes compressed.
- **Server computes, client draws.** The API returns exact pass times and metrics with no
  geometry (ADR-004). The web app rebuilds each pass's track portion from the tracks it already
  holds: one sample at each end, plus every sample in between.
- **Three views of the same pass.** Every pass appears as a row in the table, grouped by UTC day;
  as a highlighted track portion on the map; and as a mark on the timeline. Hovering any of them
  highlights the other two, and clicking any of them selects the pass and frames it on the
  timeline. Portions inside the timeline window are drawn at full strength; the others stay
  faint, so the timeline also filters the map.
- **The circle is a native MapLibre layer.** It is a geodesic circle drawn with MapLibre fill and
  line layers, which drape on the globe. A flat deck.gl polygon of up to 2,500 km radius would
  sit hundreds of kilometres below the curved surface and disappear. Circles that enclose a pole
  are drawn as an outline only.
- **Radius in plain terms.** The slider is logarithmic, so 10 km and 2,500 km are both easy to set.
  It shows the equivalent elevation above the horizon at the edge, for a 500 km orbit.
- **Requests.** Requests are debounced by 250 ms while a control moves, cached per request
  (passes never go stale within a deployment), and aborted when superseded. The previous result
  stays on screen, dimmed, while the next one loads.
- **Export.** CSV (RFC 4180) is produced in the browser from the data already on screen. Cells
  that start like a spreadsheet formula are prefixed with an apostrophe, so opening the file cannot run
  anything.
- **Rendering cost.** A hover re-renders only the two rows and two timeline marks whose state
  flips: they are memoized components with boolean store selectors. The pass layers are
  rebuilt only when the set of passes inside the timeline window changes, not on every frame of
  playback. Dragging the radius redraws the circle without re-rendering the map layers.

**Evidence.**

- **Real data.** The E2E suite drops a pin on the UAE and finds the passes of the brief's
  inspiration screenshot (06:58 YAM20, 10:07 YAM25 on 1 March).
- **Sync and export.** It checks the three-way sync (table, timeline and map hover), focusing a
  pass, dragging the pin, the filters and their link restoration, the CSV file, and that a
  satellite toggle makes no request.
- **Edge cases.** It pins next to the antimeridian (one continuous circle) and near a pole
  (outline only), and recovers from a failed request with Retry.

---

## ADR-010: Performance budgets, measured in CI

**Context.** CLAUDE.md sets performance budgets for the API and the web app. A budget that is not
measured on every change is only a hope, so Phase 5 turns each one into a gate.

**Decision.**

- **API latency: `pnpm --filter @ow/api bench`.** The script boots the production build on the
  real seeded week and measures latency from the client, body included, over keep-alive HTTP:
  - `GET /tracks/binary` (brotli): p95 < 5 ms, payload ≤ 600 KB;
  - `GET /accesses` over the full week at 2,500 km: p95 < 60 ms.

  The gated runs are sequential, because the budgets are per-request latencies; a run at 8
  concurrent requests is reported for throughput. The tracks p95 sits where GC and scheduling
  stalls begin (p50 0.8 ms, p99 about 14 ms), so it is gated on the median of three trials of 300.
  Requests send `accept-encoding` as a browser does, so the on-the-fly compression of
  `/accesses` is part of the number, and the server logs at its production level. Pins come from a seeded generator: first a pole,
  both sides of the antimeridian and the brief's UAE point, then points spread uniformly over the
  sphere. Every run queries the same places, and the hard cases are always included.
  Percentiles use the nearest rank, so they are always an observed latency.

- **Web: Lighthouse, one budget per metric.** `pnpm --filter @ow/web lighthouse` audits the
  production build five times with the desktop preset, in headless Chromium with software WebGL
  (CI runners have no GPU). It gates the median of each metric:

  | Metric                   | Budget  |
  | ------------------------ | ------- |
  | First Contentful Paint   | ≤ 1.0 s |
  | Largest Contentful Paint | ≤ 2.0 s |
  | Speed Index              | ≤ 1.5 s |
  | Cumulative Layout Shift  | ≤ 0.05  |
  | Total Blocking Time      | ≤ 2.0 s |

  The overall score is reported, not gated (decided with the project owner). The TBT ceiling is
  coarse: measured TBT is 1.0–1.5 s, so it catches a regression that adds half a second or more
  of main-thread work, not a small one. Profiling is the tool for small ones. Every run's values
  are in the job summary, so a median that hides a bad run is visible. The LCP element is the
  first-run hint, which appears once the tracks have loaded (Lighthouse starts each run with empty
  storage): changing that hint moves LCP.

- **Each run must be the real page.** A run fails unless the tracks download succeeded, since an
  error card is fast and would pass every budget.

- **Real basemap.** The audit loads the live OpenFreeMap style and tiles, as a user does; the E2E
  suite stubs them instead. A slow tile server can therefore move the web numbers. It mostly
  affects TBT and Speed Index (tile rendering). If the basemap does not load at all, the app falls
  back to a blank style, which is faster, so such a run is retried once and then fails the job
  rather than passing on a page users would not see.

- **CI.** A `perf` job runs both gates on every PR and writes the tables to the job summary; the
  raw reports are uploaded as an artifact. They are not part of the pre-push hook: they need the
  seeded data and a few minutes, and a laptop under load produces noisy numbers.

**Why the Lighthouse score is not the gate.** The first plan asked for a score ≥ 85. The app
scores 62–66. Every metric is fast except Total Blocking Time (1.0–1.5 s across runs), and profiling shows
where that time goes: WebGL start-up inside the map libraries, not app code. On a laptop GPU
(ANGLE/Direct3D):

- MapLibre creates its WebGL context in about 250 ms;
- MapLibre compiles its shaders on first use, 300–500 ms in all;
- deck.gl links its programs synchronously, about 250 ms for the first one.

Both libraries compile synchronously, so this work cannot be split or moved off the main thread.
The only ways to reach 85 would game the metric, for example by creating the map after Lighthouse
stops measuring, so the globe would appear later for real users.

**Rejected: asynchronous shader linking.** luma.gl can link programs in the background through
`KHR_parallel_shader_compile`, but it disables this by default. We tried enabling it, with a layer
extension that asks for a redraw until the programs are ready. On a GPU it cut deck.gl's blocking
from about 575 ms to 333 ms, because luma.gl still inspects each program synchronously right after
creating it. SwiftShader, which CI and the E2E suite use, does not expose the extension, so no
automated test could exercise that path. We rejected it: a modest gain in code that CI cannot check.

**Evidence.** The runs below are on this laptop with the dev servers also running. CI numbers are
in each PR's job summary.

| Budget                            | Measured                 |
| --------------------------------- | ------------------------ |
| Cached `/tracks` p95              | 2.8 ms (512 KB body)     |
| `/tracks` 304 p95                 | 0.4 ms                   |
| `/accesses` p95, 1 week, 2,500 km | 17.9 ms (server 15.8 ms) |
| `/accesses` p95, 1 week, 400 km   | 6.3 ms                   |
| 2,500 km, 8 concurrent            | 157 req/s, p95 70 ms     |
| FCP / LCP / Speed Index           | 0.85 s / 1.4 s / 1.2 s   |
| CLS / TBT                         | 0.008 / 0.95–1.5 s       |
