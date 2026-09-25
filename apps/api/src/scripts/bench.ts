/**
 * `pnpm --filter @ow/api bench` — latency benchmark of the production API against the budgets in
 * CLAUDE.md, on the real seeded week of data. Prerequisites: `pnpm build` and `pnpm seed`.
 *
 * It boots `dist/server.js` on its own port (or targets BENCH_URL), then measures client-side
 * latency, response body included, over keep-alive HTTP:
 *   - GET /tracks/binary (brotli)                      p95 < 5 ms, payload ≤ 600 KB   (gated)
 *   - GET /accesses, whole dataset, 2,500 km, seeded   p95 < 60 ms                   (gated)
 *   - 304 revalidation, 400 km accesses, 8 concurrent   reported only
 *
 * Requests are sequential for the gated runs: the budgets are per-request latencies, and
 * sequential runs keep them independent of the machine's core count. The tracks p95 sits where
 * GC and scheduling stalls start, so it is gated on the median of TRIALS runs, not one. Requests
 * carry `accept-encoding` like a browser (the API compresses /accesses on the fly), and the
 * server logs at its production level. Results go to
 * perf-results/bench.json and, in CI, to the job summary. Exits 1 when a budget is missed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { API_ROOT } from '../config.js';
import {
  API_BUDGETS,
  benchmarkPins,
  describeLimit,
  failedBudgets,
  markdownTable,
  summarize,
  summarizeOrNull,
  type BudgetCheck,
  type LatencySummary,
  type Pin,
} from '../perf/latency.js';

const BENCH_PORT = 3200;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
/** A request that takes this long is a hang, not a latency sample: fail fast with a reason. */
const REQUEST_TIMEOUT_MS = 10_000;
const MS_PER_S = 1000;
const KB = 1024;

const BUDGETS = API_BUDGETS;

const RUNS = {
  warmup: 20,
  trials: 3,
  tracks: 300,
  accesses: 200,
  concurrent: 400,
  concurrency: 8,
  pinSeed: 20_270_301,
} as const;

// No start/end: the API then covers the whole dataset (one week), the budget's worst case.
const WIDE_RADIUS_KM = 2500;
const TYPICAL_RADIUS_KM = 400;

interface Sample {
  status: number;
  bytes: number;
  ms: number;
  /** Server-side compute from the `server-timing` header, when the route reports it. */
  serverMs: number | null;
  etag: string | undefined;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: RUNS.concurrency });

function get(base: URL, pathAndQuery: string, headers: http.OutgoingHttpHeaders = {}): Promise<Sample> {
  const url = new URL(pathAndQuery, base);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.get(url, { agent, headers }, (res) => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      res.on('end', () => {
        const timing = /compute;dur=([\d.]+)/.exec(String(res.headers['server-timing'] ?? ''));
        resolve({
          status: res.statusCode ?? 0,
          bytes,
          ms: performance.now() - started,
          serverMs: timing?.[1] ? Number(timing[1]) : null,
          etag: typeof res.headers.etag === 'string' ? res.headers.etag : undefined,
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`${url.pathname}: no response within ${REQUEST_TIMEOUT_MS / MS_PER_S} s`));
    });
    req.on('error', reject);
  });
}

function expectStatus(sample: Sample, expected: number, what: string): Sample {
  if (sample.status !== expected) throw new Error(`${what}: HTTP ${sample.status}, expected ${expected}`);
  return sample;
}

async function sequential(count: number, request: (i: number) => Promise<Sample>): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let i = 0; i < count; i++) samples.push(await request(i));
  return samples;
}

async function concurrent(
  count: number,
  concurrency: number,
  request: (i: number) => Promise<Sample>,
): Promise<{ samples: Sample[]; wallMs: number }> {
  const samples: Sample[] = [];
  let next = 0;
  const started = performance.now();
  const worker = async () => {
    while (next < count) samples.push(await request(next++));
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { samples, wallMs: performance.now() - started };
}

const accessesPath = (pin: Pin, radiusKm: number) =>
  `/api/v1/accesses?${new URLSearchParams({
    lat: String(pin.lat),
    lon: String(pin.lon),
    radiusKm: String(radiusKm),
  }).toString()}`;

async function waitForReady(base: URL, server: ChildProcess | null): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (typeof server?.exitCode === 'number')
      throw new Error(`API exited early (code ${server.exitCode}); run pnpm build && pnpm seed`);
    try {
      if ((await get(base, '/readyz')).status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  // The origin only: BENCH_URL may carry credentials, which must not reach CI logs.
  throw new Error(`API not ready at ${base.origin} within ${READY_TIMEOUT_MS / MS_PER_S} s`);
}

function startServer(): ChildProcess {
  return spawn(process.execPath, [path.join(API_ROOT, 'dist', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(BENCH_PORT),
      // Production's level (a log line per request is part of the cost); the output is dropped.
      LOG_LEVEL: 'info',
      // The benchmark is one client sending hundreds of requests: lift the per-client limits.
      RATE_LIMIT_TRACKS_PER_MIN: '1000000',
      RATE_LIMIT_ACCESSES_PER_MIN: '1000000',
      RATE_LIMIT_GLOBAL_PER_MIN: '1000000',
    },
  });
}

interface Measurement {
  summary: LatencySummary;
  meanKb: number;
  /** Server-side compute, when the route reports it. */
  server: LatencySummary | null;
}

const measured = (samples: readonly Sample[]): Measurement => ({
  summary: summarize(samples.map((s) => s.ms)),
  meanKb: samples.reduce((sum, s) => sum + s.bytes, 0) / samples.length / KB,
  server: summarizeOrNull(samples.flatMap((s) => (s.serverMs === null ? [] : [s.serverMs]))),
});

interface Measurements {
  tracks: Measurement;
  /** p95 of each tracks trial; the gate reads their median. */
  tracksTrialP95Ms: number[];
  payloadKb: number;
  revalidate: Measurement;
  wide: Measurement;
  typical: Measurement;
  load: Measurement;
  loadPerSecond: number;
}

async function measure(base: URL): Promise<Measurements> {
  const br = { 'accept-encoding': 'br' };
  const tracks = () => get(base, '/api/v1/tracks/binary', br).then((s) => expectStatus(s, 200, 'tracks'));
  await sequential(RUNS.warmup, tracks);
  const tracksTrials: Sample[][] = [];
  for (let t = 0; t < RUNS.trials; t++) tracksTrials.push(await sequential(RUNS.tracks, tracks));
  const tracksRun = tracksTrials.flat();
  const etag = tracksRun[0]?.etag;
  if (!etag) throw new Error('tracks: no ETag');
  const revalidate = await sequential(RUNS.tracks, () =>
    get(base, '/api/v1/tracks/binary', { ...br, 'if-none-match': etag }).then((s) =>
      expectStatus(s, 304, 'tracks 304'),
    ),
  );

  const pins = benchmarkPins(RUNS.accesses, RUNS.pinSeed);
  const browser = { 'accept-encoding': 'br, gzip' };
  const accesses = (radiusKm: number) => (i: number) =>
    get(base, accessesPath(pins[i % pins.length] ?? { lat: 0, lon: 0 }, radiusKm), browser).then((s) =>
      expectStatus(s, 200, 'accesses'),
    );
  await sequential(RUNS.warmup, accesses(WIDE_RADIUS_KM));
  const wide = await sequential(RUNS.accesses, accesses(WIDE_RADIUS_KM));
  const typical = await sequential(RUNS.accesses, accesses(TYPICAL_RADIUS_KM));
  const load = await concurrent(RUNS.concurrent, RUNS.concurrency, accesses(WIDE_RADIUS_KM));

  return {
    tracks: measured(tracksRun),
    tracksTrialP95Ms: tracksTrials.map((trial) => summarize(trial.map((s) => s.ms)).p95Ms),
    payloadKb: (tracksRun[0]?.bytes ?? Number.NaN) / KB,
    revalidate: measured(revalidate),
    wide: measured(wide),
    typical: measured(typical),
    load: measured(load.samples),
    loadPerSecond: (RUNS.concurrent / load.wallMs) * MS_PER_S,
  };
}

/** The gate: each budget reads a named measurement, never a table position. */
const budgetChecks = (m: Measurements): BudgetCheck[] => [
  {
    name: `Cached /tracks p95 (median of ${RUNS.trials} trials)`,
    actual: summarize(m.tracksTrialP95Ms).p50Ms,
    limit: BUDGETS.tracksP95Ms,
    unit: 'ms',
    comparator: '<',
  },
  {
    name: 'Tracks payload (brotli)',
    actual: m.payloadKb,
    limit: BUDGETS.tracksPayloadKb,
    unit: 'KB',
    comparator: '≤',
  },
  {
    name: `/accesses p95 (1 week, ${WIDE_RADIUS_KM} km)`,
    actual: m.wide.summary.p95Ms,
    limit: BUDGETS.accessesP95Ms,
    unit: 'ms',
    comparator: '<',
  },
];

function report(m: Measurements, checks: readonly BudgetCheck[], failed: readonly BudgetCheck[]): string {
  const f = (v: number) => v.toFixed(2);
  const serverNote = (x: Measurement) => {
    const server = x.server ? `server p95 ${x.server.p95Ms.toFixed(1)} ms` : 'server n/a';
    return `${x.meanKb.toFixed(1)} KB · ${server}`;
  };
  const trials = m.tracksTrialP95Ms.map(f).join(' / ');
  const rows: [string, Measurement, string][] = [
    ['GET /tracks/binary (br)', m.tracks, `${m.payloadKb.toFixed(0)} KB body · trial p95s ${trials} ms`],
    ['GET /tracks/binary → 304', m.revalidate, 'If-None-Match'],
    [`GET /accesses 1 week ${WIDE_RADIUS_KM} km`, m.wide, serverNote(m.wide)],
    [`GET /accesses 1 week ${TYPICAL_RADIUS_KM} km`, m.typical, serverNote(m.typical)],
    [`… ${WIDE_RADIUS_KM} km, ${RUNS.concurrency} concurrent`, m.load, `${m.loadPerSecond.toFixed(0)} req/s`],
  ];
  const latency = markdownTable(
    ['Request', 'n', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', ''],
    rows.map(([name, { summary: s }, note]) => [
      name,
      String(s.count),
      f(s.p50Ms),
      f(s.p95Ms),
      f(s.p99Ms),
      f(s.maxMs),
      note,
    ]),
  );
  const budgets = markdownTable(
    ['Budget', 'Measured', 'Limit', ''],
    checks.map((c) => [
      c.name,
      `${f(c.actual)} ${c.unit}`,
      describeLimit(c),
      failed.includes(c) ? '❌' : '✅',
    ]),
  );
  return `### API latency\n\n${latency}\n\n${budgets}\n`;
}

const external = process.env.BENCH_URL;
const base = new URL(external ?? `http://127.0.0.1:${BENCH_PORT}`);
const server = external ? null : startServer();
try {
  await waitForReady(base, server);
  const measurements = await measure(base);
  const checks = budgetChecks(measurements);
  const failed = failedBudgets(checks);
  const markdown = report(measurements, checks, failed);
  console.log(`\n${markdown}`);

  const outDir = path.join(API_ROOT, 'perf-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'bench.json'),
    JSON.stringify({ base: base.origin, measurements, checks, failed }, null, 2),
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

  if (failed.length > 0) {
    for (const c of failed)
      console.error(`✖ ${c.name}: ${c.actual.toFixed(2)} ${c.unit} (budget ${describeLimit(c)})`);
    process.exitCode = 1;
  } else {
    console.log('✔ API latency budgets met');
  }
} finally {
  agent.destroy();
  server?.kill();
}
