import { expect, hooks, openApp, test, visibleSatellites, waitForTracks } from './fixtures';

test.describe('Error and degraded states', () => {
  test('a failed track download offers a retry that recovers', async ({ page }) => {
    let fail = true;
    await page.route('**/api/v1/tracks/binary', (route) =>
      fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fallback(),
    );
    await page.goto('/');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Could not load the satellite data', { timeout: 20_000 });
    fail = false;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await waitForTracks(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a failed dataset request explains itself', async ({ page }) => {
    await page.route('**/api/v1/dataset', (route) =>
      route.fulfill({
        status: 500,
        json: {
          statusCode: 500,
          error: 'Internal Server Error',
          message: 'Something went wrong',
          requestId: 'req-1',
        },
      }),
    );
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Something went wrong', { timeout: 20_000 });
  });

  test('an unreachable server and corrupt track data are explained', async ({ page }) => {
    await page.route('**/api/v1/tracks/binary', (route) => route.abort());
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('could not be reached', { timeout: 20_000 });

    await page.unroute('**/api/v1/tracks/binary');
    await page.route('**/api/v1/tracks/binary', (route) => route.fulfill({ status: 200, body: 'garbage' }));
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('corrupt', { timeout: 20_000 });
  });

  test('the tracks still render on a fallback style when the basemap is unreachable', async ({ page }) => {
    await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
    await openApp(page);
    await expect(page.getByTestId('satellite-count')).toHaveText('10/10');
    expect(await visibleSatellites(page)).toHaveLength(10);
    const style = await page.evaluate(() => {
      const map = window.__OW_E2E__?.map;
      return map
        ? { sources: Object.keys(map.getStyle().sources), first: map.getStyle().layers[0]?.id }
        : null;
    });
    // Only the app's own accesses circle source: no basemap tiles.
    expect(style).toEqual({ sources: ['access-circle'], first: 'background' });
    expect(await page.evaluate(() => window.__OW_E2E__?.styleLoaded())).toBe(true);
    expect((await hooks.state(page)).t0S).not.toBeNull();
  });

  test('a failed passes request offers a retry that recovers', async ({ page }) => {
    let fail = true;
    await page.route('**/api/v1/accesses**', (route) =>
      fail
        ? route.fulfill({
            status: 503,
            json: { statusCode: 503, error: 'Service Unavailable', message: 'Busy, try again' },
          })
        : route.fallback(),
    );
    await openApp(page, '?pin=24.454,54.377');
    const panel = page.getByTestId('access-panel');
    await expect(panel.getByRole('alert')).toContainText('Busy, try again', { timeout: 20_000 });
    fail = false;
    await panel.getByRole('button', { name: /Retry/ }).click();
    await expect(panel.locator('[data-pass-id]').first()).toBeVisible();
  });
});
