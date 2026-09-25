// Lighthouse gate on the production build (budgets in lighthouseBudgets.mjs, ADR-010).
// Prerequisites: `pnpm build` and `pnpm seed`.
//
// Serves apps/web/dist with `vite preview` (proxying /api like nginx does in Docker) in front of
// the production API, audits the page RUNS times with Lighthouse's desktop preset and gates each
// metric's median (single Lighthouse runs vary; every run is shown in the summary). A run only
// counts if the app loaded its data and the live basemap loaded (a degraded basemap makes the
// page faster and would hide a regression); a degraded run is retried, then fails the job. Reports go to lighthouse-report/; in CI a summary
// is appended to the job summary.
//
// Desktop preset: this is a desktop map explorer (a globe, a timeline and a pass table side by
// side). The mobile preset's 4× CPU throttling on top of software WebGL (no GPU on CI runners)
// measures the emulator, not the app.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';

import {
  LIGHTHOUSE_BUDGETS,
  BASEMAP_HOST,
  TRACKS_PATH,
  appLoaded,
  basemapLoaded,
  evaluateBudgets,
  formatMetric,
  median,
} from './lighthouseBudgets.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 3300;
const WEB_PORT = 4300;
const RUNS = 5;
/** Attempts per run when the live basemap did not load (a transient third-party failure). */
const BASEMAP_ATTEMPTS = 2;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
/** One readiness probe; a server that accepts but never answers must not hang the job. */
const PROBE_TIMEOUT_MS = 5_000;
const PERCENT = 100;
const MS_PER_S = 1000;
const OUT_DIR = path.join(WEB_ROOT, 'lighthouse-report');
const CATEGORIES = [
  ['performance', 'Performance'],
  ['accessibility', 'Accessibility'],
  ['best-practices', 'Best practices'],
  ['seo', 'SEO'],
];

/**
 * Chrome flags: headless and software WebGL (no GPU on CI runners). The sandbox is off on GitHub
 * Actions only: Ubuntu 24.04 runners restrict the unprivileged user namespaces it needs (Playwright
 * turns it off there too). Never on a developer machine, whatever CI is set to.
 */
const CHROME_FLAGS = [
  '--headless=new',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  ...(process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : []),
];

/**
 * Both servers run on this Node binary directly: no shell, so paths with spaces work on Windows
 * and kill() reaches the server itself rather than a wrapper that would leave it running.
 */
function startNode(script, args, env) {
  return spawn(process.execPath, [script, ...args], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** Waits until `url` answers OK; fails at once if one of the servers has exited (missing build, busy port). */
async function waitFor(url, servers) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exited = servers.find((s) => typeof s.exitCode === 'number');
    if (exited) throw new Error(`${exited.spawnargs.slice(1).join(' ')} exited (code ${exited.exitCode})`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(`${url} not ready within ${READY_TIMEOUT_MS / MS_PER_S} s (run pnpm build && pnpm seed)`);
}

function report(results, scores) {
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return [
    `### Lighthouse (desktop, median of ${RUNS})`,
    '',
    row(['Metric', 'Median', 'Budget', '', 'Runs']),
    row(['---', '---', '---', '---', '---']),
    ...results.map((r) =>
      row([
        r.label,
        formatMetric(r.value, r.unit),
        `≤ ${formatMetric(r.max, r.unit)}`,
        r.passed ? '✅' : '❌',
        r.values.map((v) => formatMetric(v ?? Number.NaN, r.unit)).join(' · '),
      ]),
    ),
    '',
    row(CATEGORIES.map(([, label]) => label)),
    row(CATEGORIES.map(() => '---')),
    row(CATEGORIES.map(([id]) => String(scores[id]))),
    '',
    '_Category scores are reported, not gated (ADR-010)._',
    '',
  ].join('\n');
}

const servers = [
  startNode(path.join(WEB_ROOT, '..', 'api', 'dist', 'server.js'), [], {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
  }),
  startNode(
    path.join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    ['preview', '--outDir', 'dist', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'],
    { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
  ),
];

let chrome;
try {
  const url = `http://127.0.0.1:${WEB_PORT}/`;
  await waitFor(`http://127.0.0.1:${API_PORT}/readyz`, servers);
  await waitFor(url, servers);
  chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: CHROME_FLAGS });
  mkdirSync(OUT_DIR, { recursive: true });

  /** One audit; retried when the live basemap did not load, failed if it never does. */
  const audit = async (i) => {
    for (let attempt = 1; attempt <= BASEMAP_ATTEMPTS; attempt++) {
      const result = await lighthouse(
        url,
        // Error reporting stays off explicitly: Lighthouse can send errors (with page URLs) to Sentry.
        { port: chrome.port, output: 'html', logLevel: 'error', enableErrorReporting: false },
        desktopConfig,
      );
      if (!result) throw new Error('Lighthouse returned no result');
      const { lhr } = result;
      if (lhr.runtimeError) throw new Error(`Lighthouse: ${lhr.runtimeError.message}`);
      if (!appLoaded(lhr))
        throw new Error(`Run ${i}: ${TRACKS_PATH} did not load; the page measured is not the app`);
      if (basemapLoaded(lhr)) return result;
      console.warn(`  run ${i}: the ${BASEMAP_HOST} basemap did not load (attempt ${attempt})`);
    }
    throw new Error(
      `Run ${i}: the ${BASEMAP_HOST} basemap did not load; the numbers would not be the real page's`,
    );
  };

  const metricRuns = [];
  const scoreRuns = [];
  for (let i = 1; i <= RUNS; i++) {
    const { lhr, report: html } = await audit(i);
    writeFileSync(path.join(OUT_DIR, `run-${i}.html`), html);
    writeFileSync(path.join(OUT_DIR, `run-${i}.json`), JSON.stringify(lhr));
    metricRuns.push(
      Object.fromEntries(LIGHTHOUSE_BUDGETS.map((b) => [b.id, lhr.audits[b.id]?.numericValue])),
    );
    scoreRuns.push(
      Object.fromEntries(
        CATEGORIES.map(([id]) => [id, Math.round((lhr.categories[id]?.score ?? 0) * PERCENT)]),
      ),
    );
    console.log(`  run ${i}: performance score ${scoreRuns.at(-1).performance}`);
  }

  const results = evaluateBudgets(metricRuns);
  const scores = Object.fromEntries(CATEGORIES.map(([id]) => [id, median(scoreRuns.map((s) => s[id]))]));
  const markdown = report(results, scores);
  console.log(`\n${markdown}`);
  writeFileSync(
    path.join(OUT_DIR, 'summary.json'),
    JSON.stringify({ results, scores, metricRuns, scoreRuns }, null, 2),
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    console.log('✔ Lighthouse budgets met');
  } else {
    for (const r of failed)
      console.error(`✖ ${r.label} ${formatMetric(r.value, r.unit)} > ${formatMetric(r.max, r.unit)}`);
    process.exitCode = 1;
  }
} finally {
  await chrome?.kill();
  for (const server of servers) server.kill();
}
