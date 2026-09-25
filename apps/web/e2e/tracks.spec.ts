import {
  MIN_TRACK_PIXELS,
  colouredPixels,
  expect,
  hooks,
  mapProjection,
  openApp,
  recordApiRequests,
  test,
  visibleSatellites,
} from './fixtures';

const ALL = ['YAM20', 'YAM21', 'YAM22', 'YAM23', 'YAM24', 'YAM25', 'YAM26', 'YAM27', 'YAM28', 'YAM29'];

test.describe('Tracks and satellite filter', () => {
  test('loads the week and draws every satellite', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('dataset-summary')).toContainText('10 satellites');
    await expect(page.getByTestId('satellite-count')).toHaveText('10/10');
    await expect(page.getByTestId('loading')).toHaveCount(0);
    expect(await visibleSatellites(page)).toEqual(ALL);
    // Only the 12 h chunks overlapping the default 6 h window are drawn: one per satellite.
    const visible = (await hooks.layers(page)).filter((l) => l.id.startsWith('track:') && l.visible);
    expect(visible).toHaveLength(10);
    // The window is passed to the GPU relative to the dataset epoch.
    expect(visible[0]).toMatchObject({ windowStartRelS: 0, windowEndRelS: 6 * 3600 });
    // And they reach the screen (layer props alone do not prove deck.gl drew anything).
    await expect.poll(() => colouredPixels(page)).toBeGreaterThan(MIN_TRACK_PIXELS);
    // Negative control: with every satellite hidden, the colour is gone (it came from the tracks).
    await page.getByRole('region', { name: 'Satellites' }).getByRole('button', { name: 'None' }).click();
    await expect.poll(() => colouredPixels(page)).toBeLessThan(MIN_TRACK_PIXELS / 10);
  });

  test('hides, solos and restores satellites without any network request', async ({ page }) => {
    await openApp(page);
    const requests = recordApiRequests(page);

    // The checkbox is drawn as a color swatch; users click the row label.
    await page.getByText('YAM21', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'YAM21' })).not.toBeChecked();
    await expect(page.getByTestId('satellite-count')).toHaveText('9/10');
    await expect.poll(() => visibleSatellites(page)).toEqual(ALL.filter((id) => id !== 'YAM21'));

    await page.getByRole('checkbox', { name: 'YAM22' }).locator('xpath=ancestor::li').hover();
    await page.getByRole('button', { name: 'Show only YAM22' }).click();
    await expect(page.getByTestId('satellite-count')).toHaveText('1/10');
    await expect.poll(() => visibleSatellites(page)).toEqual(['YAM22']);

    await page.getByRole('button', { name: 'None' }).click();
    await expect(page.getByTestId('satellite-count')).toHaveText('0/10');
    await page.getByRole('region', { name: 'Satellites' }).getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId('satellite-count')).toHaveText('10/10');
    await expect.poll(() => visibleSatellites(page)).toEqual(ALL);

    expect(requests.map((r) => r.url())).toEqual([]);
  });

  test('hovering a satellite emphasizes it; hiding it from the row removes the emphasis', async ({
    page,
  }) => {
    await openApp(page);
    const opacities = async (): Promise<Record<string, number>> => {
      const layers = (await hooks.layers(page)).filter((l) => l.id.startsWith('track:') && l.visible);
      return Object.fromEntries(layers.map((l): [string, number] => [l.id.split(':')[1] ?? '', l.opacity]));
    };
    await page.getByText('YAM22', { exact: true }).hover();
    await expect.poll(async () => (await opacities()).YAM22).toBe(1);
    expect((await opacities()).YAM20).toBeLessThan(0.5);

    // Hide the hovered satellite: the others must not stay dimmed.
    await page.getByText('YAM22', { exact: true }).click();
    await expect.poll(async () => Object.values(await opacities()).every((o) => o === 1)).toBe(true);
  });

  test('keyboard shortcuts toggle and solo satellites', async ({ page }) => {
    await openApp(page);
    await page.locator('body').press('1');
    await expect(page.getByRole('checkbox', { name: 'YAM20' })).not.toBeChecked();
    await page.locator('body').press('Shift+Digit3');
    await expect(page.getByTestId('satellite-count')).toHaveText('1/10');
    await expect(page.getByRole('checkbox', { name: 'YAM22' })).toBeChecked();
    await page.locator('body').press('a');
    await expect(page.getByTestId('satellite-count')).toHaveText('10/10');
  });

  test('switches between globe and flat maps', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Flat/ }).click();
    await expect.poll(() => mapProjection(page)).toBe('mercator');
    await page.locator('body').press('g');
    await expect.poll(() => mapProjection(page)).toBe('globe');
    expect((await hooks.state(page)).projection).toBe('globe');
  });
});
