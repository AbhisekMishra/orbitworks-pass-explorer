import { readFileSync } from 'node:fs';

import type { GeoJSONSource } from 'maplibre-gl';

import { expect, hooks, openApp, test, type Page } from './fixtures';

/** The place from the brief's inspiration screenshot (UAE): known passes on 1 March. */
const UAE = { lat: 24.454, lon: 54.377 };
const PIN_LINK = `?pin=${UAE.lat},${UAE.lon}&map=24.00,55.00,4.5`;

async function clickMapAt(page: Page, lon: number, lat: number): Promise<void> {
  const point = await page.evaluate(
    ([x, y]) => {
      const map = window.__OW_E2E__?.map;
      if (!map) return null;
      const p = map.project([x, y]);
      const rect = map.getContainer().getBoundingClientRect();
      return { x: rect.left + p.x, y: rect.top + p.y };
    },
    [lon, lat] as const,
  );
  if (!point) throw new Error('map not ready');
  await page.mouse.click(point.x, point.y);
}

const rows = (page: Page) => page.getByTestId('access-panel').locator('[data-pass-id]');
const ticks = (page: Page) => page.getByTestId('timeline-passes').locator('button');

/** The circle's geometries: their type, and the longitudes of the outline. */
const circleGeometries = (page: Page) =>
  page.evaluate(async () => {
    const data = await window.__OW_E2E__?.map.getSource<GeoJSONSource>('access-circle')?.getData();
    if (data?.type !== 'FeatureCollection') return [];
    return data.features.map((f) => ({
      type: f.geometry.type,
      lons: f.geometry.type === 'LineString' ? f.geometry.coordinates.map((c) => c[0] ?? 0) : [],
    }));
  });

test.describe('Accesses', () => {
  test('clicking the map drops a pin and lists the passes over it, by day', async ({ page }) => {
    await openApp(page, '?map=24.00,55.00,4.5');
    await expect(page.getByTestId('access-prompt')).toContainText('Click anywhere on the map');

    await clickMapAt(page, UAE.lon, UAE.lat);
    const panel = page.getByTestId('access-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('access-pin')).toContainText('24.4');
    await expect(page.getByTestId('access-pin')).toContainText('54.3');

    // The first passes of 1 March match the brief's inspiration screenshot.
    const firstDay = panel.getByRole('region', { name: '2027-03-01' });
    await expect(firstDay).toContainText('Mon 01 Mar');
    await expect(firstDay.locator('[data-pass-id]').first()).toContainText('06:58');
    await expect(firstDay.locator('[data-pass-id]').first()).toContainText('YAM20');
    await expect(firstDay).toContainText('YAM25');
    await expect(page.getByTestId('access-stats')).toContainText('Passes');
    expect(await rows(page).count()).toBeGreaterThan(20);

    // The same passes are marked on the timeline.
    expect(await ticks(page).count()).toBe(await rows(page).count());
    // Within ~1 km of the clicked point (screen pixel precision).
    await expect(page).toHaveURL(/pin=24\.4\d\d,54\.3\d\d/);
  });

  test('table, timeline and map stay in sync; clicking a pass frames it', async ({ page }) => {
    await openApp(page, PIN_LINK);
    const first = rows(page).first();
    await expect(first).toBeVisible();
    const id = await first.getAttribute('data-pass-id');
    if (!id) throw new Error('row without a pass id');

    // Row → timeline and map.
    await first.hover();
    await expect.poll(async () => (await hooks.state(page)).hoveredPassId).toBe(id);
    await expect(ticks(page).and(page.locator(`[data-pass-id="${id}"]`))).toHaveAttribute(
      'data-hovered',
      'true',
    );

    // Timeline → table, on a mark far enough from its neighbours to be hovered unambiguously.
    const boxes = await ticks(page).evaluateAll((els) =>
      els.map((el) => ({ id: el.getAttribute('data-pass-id'), x: el.getBoundingClientRect().x })),
    );
    const isolated = boxes.find(
      (b, i) => i > 0 && b.x - boxes[i - 1]!.x > 12 && (boxes[i + 1]?.x ?? Infinity) - b.x > 12,
    );
    if (!isolated?.id) throw new Error('no isolated timeline mark');
    await ticks(page)
      .and(page.locator(`[data-pass-id="${isolated.id}"]`))
      .hover();
    await expect(rows(page).and(page.locator(`[data-pass-id="${isolated.id}"]`))).toHaveAttribute(
      'data-hovered',
      'true',
    );

    // Click frames the pass on the timeline and selects it everywhere.
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await hooks.state(page)).selectedPassId).toBe(id);
    const { timeWindow } = await hooks.state(page);
    expect(timeWindow.endS - timeWindow.startS).toBeLessThan(3600);
    await expect(page.getByLabel('Window start (UTC)')).toHaveValue('2027-03-01T06:48');
  });

  test('hovering a pass on the map shows it and highlights its row; clicking it focuses it', async ({
    page,
  }) => {
    await openApp(page, PIN_LINK);
    await expect(rows(page).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__OW_E2E__?.passPoint() ?? null)).not.toBeNull();
    const point = await page.evaluate(() => window.__OW_E2E__!.passPoint());
    if (!point) throw new Error('no pass on screen');
    const pinBefore = (await hooks.state(page)).pin;

    await page.mouse.move(point.x, point.y);
    const tooltip = page.getByTestId('pass-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('pass');
    await expect.poll(async () => (await hooks.state(page)).hoveredPassId).not.toBeNull();
    const hovered = (await hooks.state(page)).hoveredPassId!;
    await expect(rows(page).and(page.locator(`[data-pass-id="${hovered}"]`))).toHaveAttribute(
      'data-hovered',
      'true',
    );

    await page.mouse.click(point.x, point.y);
    await expect.poll(async () => (await hooks.state(page)).selectedPassId).toBe(hovered);
    expect((await hooks.state(page)).pin).toEqual(pinBefore); // focusing a pass does not move the pin
  });

  test('the pin can be dragged to a new place', async ({ page }) => {
    await openApp(page, PIN_LINK);
    await expect(rows(page).first()).toBeVisible();
    const marker = page.locator('[title="Drag to move the pin"]');
    const box = await marker.boundingBox();
    if (!box) throw new Error('pin marker not laid out');
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/accesses')) requests.push(r.url());
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height - 4, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await hooks.state(page)).pin?.lon).toBeGreaterThan(UAE.lon + 0.5);
    await expect.poll(() => page.url()).not.toContain(`pin=${UAE.lat},${UAE.lon}`);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
  });

  test('radius, days and the daylight filter refine the list, and survive a reload', async ({ page }) => {
    await openApp(page, PIN_LINK);
    await expect(rows(page).first()).toBeVisible();
    const panel = page.getByTestId('access-panel');

    // Some passes are at night before the filter: it must actually remove them, and keep the rest.
    expect(await panel.getByLabel('night').count()).toBeGreaterThan(0);
    await page.getByText('Daylight passes only').click();
    await expect(panel.getByLabel('night')).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
    const daylight = await rows(page).count();

    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/accesses')) requests.push(r.url());
    });
    await page.getByRole('slider', { name: 'Radius' }).focus();
    await page.keyboard.press('PageDown'); // a big step down
    await expect.poll(async () => (await hooks.state(page)).radiusKm).toBeLessThan(400);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await expect.poll(() => rows(page).count()).toBeLessThan(daylight);
    const { radiusKm } = await hooks.state(page);

    // Both ends of the day range: 2 and 3 March.
    await page.getByLabel('Last day (UTC)').fill('2027-03-03');
    await expect(panel.getByRole('region')).toHaveCount(3);
    await page.getByLabel('First day (UTC)').fill('2027-03-02');
    await expect(panel.getByRole('region')).toHaveCount(2);
    await expect(panel.getByRole('region').first()).toHaveAccessibleName('2027-03-02');
    await expect.poll(() => page.url()).toContain(`r=${radiusKm}&afrom=2027-03-02&ato=2027-03-03&daylight=1`);

    await page.reload();
    await expect(page.getByTestId('access-radius')).toHaveText(`${radiusKm.toLocaleString('en-US')} km`);
    await expect(page.getByLabel('First day (UTC)')).toHaveValue('2027-03-02');
    await expect(page.getByLabel('Last day (UTC)')).toHaveValue('2027-03-03');
    await expect(page.getByLabel('Daylight passes only')).toBeChecked();
    await expect(panel.getByRole('region')).toHaveCount(2);
  });

  test('toggling satellites filters the passes without asking the server again', async ({ page }) => {
    await openApp(page, PIN_LINK);
    await expect(rows(page).first()).toBeVisible();
    const all = await rows(page).count();
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/')) requests.push(r.url());
    });
    await page.getByText('YAM20', { exact: true }).first().click();
    await expect.poll(() => rows(page).count()).toBeLessThan(all);
    await expect(rows(page).filter({ hasText: 'YAM20' })).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test('with a pin set, scrubbing and toggling cost no request; only a query change does', async ({
    page,
  }) => {
    await openApp(page, PIN_LINK);
    await expect(rows(page).first()).toBeVisible();
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/')) requests.push(r.url());
    });
    await page.getByText('YAM20', { exact: true }).first().click();
    await page.getByRole('button', { name: '1 d', exact: true }).click();
    await page.getByTestId('timeline-window').focus();
    await page.keyboard.press('ArrowRight');
    // A real query change, debounced like everything else: had the toggle or the scrub scheduled
    // a request, it would be recorded before this one. So the only request is the radius one.
    await page.getByRole('slider', { name: 'Radius' }).focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    const { radiusKm } = await hooks.state(page);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(`radiusKm=${radiusKm}`);
  });

  test('exports the passes as CSV', async ({ page }) => {
    await openApp(page, PIN_LINK);
    await expect(rows(page).first()).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download passes as CSV' }).click();
    const file = await download;
    // The dataset ends at 2027-03-08T00:01Z, so the default days include 8 March.
    expect(file.suggestedFilename()).toBe('passes_24.45N_54.38E_400km_2027-03-01_2027-03-08.csv');
    const csv = readFileSync(await file.path(), 'utf8').split('\r\n');
    expect(csv[0]).toMatch(/^satellite,start_utc,end_utc,duration_s,/);
    expect(csv[1]).toMatch(/^YAM20,2027-03-01T06:58:\d\dZ,/);
    expect(csv.length - 2).toBe(await rows(page).count()); // header + trailing newline
  });

  test('the pin is kept in the link and removed with Esc, with its passes', async ({ page }) => {
    await openApp(page, PIN_LINK);
    await expect(page.getByTestId('access-panel')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('access-panel')).toBeVisible();
    await expect(ticks(page).first()).toBeVisible();

    await page.locator('body').press('Escape');
    await expect(page.getByTestId('access-prompt')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain('pin=');
    await expect(page.getByTestId('timeline-passes')).toHaveCount(0);
  });

  test('explains when no satellite is selected, and shows no stale passes', async ({ page }) => {
    await openApp(page, PIN_LINK);
    await expect(ticks(page).first()).toBeVisible();
    await page.getByRole('region', { name: 'Satellites' }).getByRole('button', { name: 'None' }).click();
    await expect(page.getByTestId('access-panel')).toContainText('Select at least one satellite');
    await expect(page.getByTestId('timeline-passes')).toHaveCount(0);
    await expect
      .poll(async () => (await hooks.layers(page)).some((l) => l.id === 'access-passes'))
      .toBe(false);
  });

  test('pins next to the antimeridian and near a pole work', async ({ page }) => {
    await openApp(page, '?pin=0,179.9&map=0.00,179.90,4.0');
    await expect(page.getByTestId('access-pin')).toContainText('179.90° E');
    await expect(rows(page).first()).toBeVisible();
    await expect(page).toHaveURL(/pin=0\.000,179\.900/);
    // One continuous ring (no line across the world): its longitudes span a few degrees only.
    await expect.poll(async () => (await circleGeometries(page)).length).toBe(2);
    const lons = (await circleGeometries(page)).find((g) => g.type === 'LineString')?.lons ?? [];
    expect(lons.length).toBeGreaterThan(0);
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(20);

    await page.goto('/?pin=85,0&r=1000');
    await expect(page.getByTestId('access-pin')).toContainText('85.00° N');
    // A circle around the pole is drawn as an outline only.
    await expect.poll(async () => (await circleGeometries(page)).map((g) => g.type)).toEqual(['LineString']);
  });
});
