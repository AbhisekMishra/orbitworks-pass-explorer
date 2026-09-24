import { expect, hooks, mapProjection, openApp, test } from './fixtures';

/** "HH:MM" of an epoch time, UTC. */
const hhmm = (epochS: number) => new Date(epochS * 1000).toISOString().slice(11, 16);

test.describe('Track hover tooltip', () => {
  test('hovering a track shows the satellite, the UTC time and the ground conditions', async ({ page }) => {
    // Flat map: every projected track point is on screen (no far side of the globe).
    await openApp(page, '?proj=flat&map=20.00,40.00,1.6');
    await expect.poll(() => mapProjection(page)).toBe('mercator');
    const point = await hooks.trackPoint(page);
    expect(point).not.toBeNull();
    if (!point) return;

    await page.mouse.move(point.x, point.y);
    const tooltip = page.getByTestId('track-tooltip');
    await expect(tooltip).toBeVisible();
    // The point is isolated from other satellites, so the tooltip must name its satellite and
    // time (within a minute: the pointer lands on the nearest instant of the drawn track).
    await expect(tooltip).toContainText(point.satellite);
    const minutes = [-60, 0, 60].map((d) => hhmm(point.timeS + d));
    const text = (await tooltip.textContent()) ?? '';
    expect(minutes.some((m) => text.includes(m))).toBe(true);
    await expect(tooltip).toContainText('UTC');
    await expect(tooltip).toContainText('km');
    await expect(tooltip).toContainText(/Sunlit|Dark/);

    // Leaving the map hides it.
    await page.mouse.move(640, 790);
    await expect(tooltip).toHaveCount(0);
  });
});
