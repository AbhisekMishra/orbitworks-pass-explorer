/**
 * Smoke test of a deployed build, with no test hooks: the production image behind nginx in CI
 * (docker job), and the live Vercel + Railway deployment after each production deploy
 * (deployed-smoke workflow). It proves what the E2E suite cannot: the app works under the
 * production CSP and headers, workers load, and, on Vercel, the cross-origin API calls pass CORS.
 */
import { expect, test } from '@playwright/test';

/** The brief's inspiration example: 46 passes over the UAE in the week at the default 400 km. */
const UAE_PIN_LINK = '/?pin=24.454,54.377';
const UAE_PASS_COUNT = '46';
const TRACKS_PATH = '/api/v1/tracks/binary';
const LOAD_TIMEOUT_MS = 45_000;

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test('the deployed app loads its data and works under the production CSP', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations?.push(`${e.effectiveDirective} blocked ${e.blockedURI}`);
    });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // The tracks are fetched by the decode worker: context-level events include worker requests.
  const tracks = context.waitForEvent('response', {
    predicate: (r) => new URL(r.url()).pathname === TRACKS_PATH,
    timeout: LOAD_TIMEOUT_MS,
  });

  await page.goto(UAE_PIN_LINK);

  expect((await tracks).status()).toBe(200);
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: LOAD_TIMEOUT_MS });
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.getByTestId('satellite-count')).toHaveText('10/10');
  // The passes come from the API (cross-origin on Vercel): the whole round trip works.
  await expect(page.getByTestId('access-stats')).toContainText(UAE_PASS_COUNT, { timeout: LOAD_TIMEOUT_MS });
  await expect(page.getByRole('alert')).toHaveCount(0);

  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
