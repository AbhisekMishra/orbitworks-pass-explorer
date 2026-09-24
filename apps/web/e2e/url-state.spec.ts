import { expect, hooks, mapProjection, openApp, test } from './fixtures';

test.describe('Shareable URL state', () => {
  test('the view survives a reload', async ({ page }) => {
    await openApp(page);
    await page.getByText('YAM21', { exact: true }).click();
    await page.getByRole('button', { name: '1 d', exact: true }).click();
    await page.getByRole('button', { name: /Flat/ }).click();
    await expect(page).toHaveURL(/from=2027-03-01T00:00Z&to=2027-03-02T00:00Z&proj=flat/);
    expect(page.url()).not.toContain('YAM21');

    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'YAM21' })).not.toBeChecked();
    await expect(page.getByTestId('satellite-count')).toHaveText('9/10');
    await expect(page.getByTestId('window-duration')).toHaveText('1 d');
    await expect(page.getByRole('button', { name: /Flat/ })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => mapProjection(page)).toBe('mercator');
  });

  test('a shared link opens the same window and satellites', async ({ page }) => {
    await openApp(page, '?sats=YAM25,YAM28&from=2027-03-03T06:00Z&to=2027-03-03T09:00Z');
    await expect(page.getByTestId('satellite-count')).toHaveText('2/10');
    await expect(page.getByLabel('Window start (UTC)')).toHaveValue('2027-03-03T06:00');
    await expect(page.getByTestId('window-duration')).toHaveText('3 h');
    expect((await hooks.state(page)).hidden).toHaveLength(8);
  });

  test('the camera is restored from a link and written back, across the antimeridian', async ({ page }) => {
    await openApp(page, '?map=10.00,-170.00,3.0');
    const center = await page.evaluate(() => window.__OW_E2E__?.map.getCenter().toArray());
    expect(center?.[0]).toBeCloseTo(-170, 1);
    expect(center?.[1]).toBeCloseTo(10, 1);
    // Panning east past 180° is written back as a normalized longitude.
    await page.evaluate(() => window.__OW_E2E__?.map.jumpTo({ center: [190, 0], zoom: 3 }));
    await expect(page).toHaveURL(/map=0\.00,-170\.00,3\.0/);
  });

  test('a malformed link falls back to defaults instead of breaking', async ({ page }) => {
    await openApp(page, '?sats=<script>&from=yesterday&to=2027-03-03T09:00Z&proj=warp&map=999,0,1');
    await expect(page.getByTestId('satellite-count')).toHaveText('10/10');
    await expect(page.getByTestId('window-duration')).toHaveText('6 h');
    await expect(page.getByRole('button', { name: /Globe/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
