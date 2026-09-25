// Lighthouse budgets (CLAUDE.md "Performance budgets", ADR-010): one budget per metric the app
// controls, gated on the median of several runs. The overall score is reported, not gated: on a
// cold start its Total Blocking Time is dominated by WebGL context creation and shader compilation
// inside MapLibre and deck.gl. Speed Index and TBT limits are set from the CI runner (software
// WebGL, about 2× slower than a laptop), where the gate runs. TBT still has a ceiling, so a
// regression in our own main-thread
// work fails the gate.

/** @typedef {{ id: string, label: string, max: number, unit: 'ms' | '' }} MetricBudget */

/** @type {readonly MetricBudget[]} */
export const LIGHTHOUSE_BUDGETS = [
  { id: 'first-contentful-paint', label: 'FCP', max: 1000, unit: 'ms' },
  { id: 'largest-contentful-paint', label: 'LCP', max: 2000, unit: 'ms' },
  { id: 'speed-index', label: 'Speed Index', max: 2400, unit: 'ms' },
  { id: 'cumulative-layout-shift', label: 'CLS', max: 0.05, unit: '' },
  { id: 'total-blocking-time', label: 'TBT', max: 4000, unit: 'ms' },
];

/** Median of a non-empty list (the upper middle for an even count: never flatters the result). */
export function median(values) {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Median of each budgeted metric across runs, and whether it is within budget (`≤ max`).
 * A metric missing from any run fails: nothing measured is not a pass.
 * @param {readonly Record<string, number | undefined>[]} runs numeric values by audit id
 */
export function evaluateBudgets(runs, budgets = LIGHTHOUSE_BUDGETS) {
  return budgets.map((budget) => {
    const values = runs.map((run) => run[budget.id]);
    const measured = values.length > 0 && values.every((v) => typeof v === 'number' && Number.isFinite(v));
    const value = measured ? median(values) : Number.NaN;
    return { ...budget, values, value, passed: measured && value <= budget.max };
  });
}

/** The request whose success proves the app loaded (not its error card). */
export const TRACKS_PATH = '/api/v1/tracks/binary';

/**
 * Successful requests of a Lighthouse run, as parsed URLs. Matching is on parsed parts (exact
 * hostname, pathname), never substrings: a URL can carry any host name in its path or query.
 * @param {{ audits: Record<string, { details?: { items?: readonly { url?: string, statusCode?: number }[] } } | undefined> }} lhr
 */
function okRequests(lhr) {
  return (lhr.audits['network-requests']?.details?.items ?? []).flatMap((r) =>
    r.statusCode === 200 && typeof r.url === 'string' && URL.canParse(r.url) ? [new URL(r.url)] : [],
  );
}

/**
 * Whether the audited page loaded the app's data: the tracks download succeeded. Without this, a
 * broken proxy or API would show the error card, which is fast, and the budgets would pass.
 * @param {Parameters<typeof okRequests>[0]} lhr
 */
export function appLoaded(lhr) {
  return okRequests(lhr).some((u) => u.pathname === TRACKS_PATH);
}

/** The live basemap host (ADR-010: the audit measures the real page, basemap included). */
export const BASEMAP_HOST = 'tiles.openfreemap.org';

/**
 * Whether the audited page got the real basemap: its style and at least one vector tile loaded.
 * If the host is down the app falls back to a blank style, which is faster; such a run must not
 * count as a pass.
 * @param {Parameters<typeof okRequests>[0]} lhr
 */
export function basemapLoaded(lhr) {
  const basemap = okRequests(lhr).filter((u) => u.hostname === BASEMAP_HOST);
  return (
    basemap.some((u) => u.pathname.startsWith('/styles/')) && basemap.some((u) => u.pathname.endsWith('.pbf'))
  );
}

/** "1,234 ms" / "0.012": how a metric is shown in the report. */
export function formatMetric(value, unit) {
  if (Number.isNaN(value)) return 'n/a';
  return unit === 'ms' ? `${Math.round(value).toLocaleString('en-US')} ms` : value.toFixed(3);
}
