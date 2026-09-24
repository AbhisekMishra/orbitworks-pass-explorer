import { expect, hooks, openApp, recordApiRequests, test, type Page } from './fixtures';

const H = 3600;

/**
 * The window the GPU is filtering on (seconds since the dataset epoch), read from a visible track
 * chunk: hidden chunks carry constant uniforms.
 */
async function trackWindow(page: Page): Promise<[number, number]> {
  const layer = (await hooks.layers(page)).find((l) => l.id.startsWith('track:') && l.visible);
  return [Number(layer?.windowStartRelS), Number(layer?.windowEndRelS)];
}

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not laid out`);
  return b;
}

test.describe('Timeline', () => {
  test('presets change the drawn window on the GPU with zero network requests', async ({ page }) => {
    await openApp(page);
    const requests = recordApiRequests(page);

    const visibleChunks = async () =>
      (await hooks.layers(page)).filter((l) => l.id.startsWith('track:') && l.visible).length;
    expect(await visibleChunks()).toBe(10);

    await page.getByRole('button', { name: '1 d', exact: true }).click();
    await expect(page.getByTestId('window-duration')).toHaveText('1 d');
    await expect.poll(() => trackWindow(page)).toEqual([0, 24 * H]);
    // A longer window draws more 12 h chunks, from the same GPU buffers.
    await expect.poll(visibleChunks).toBe(30);

    await page.getByRole('group', { name: 'Window length' }).getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId('window-duration')).toHaveText('7 d');

    await page.getByRole('button', { name: '1 h', exact: true }).click();
    await expect.poll(() => trackWindow(page)).toEqual([0, H]);

    expect(requests).toHaveLength(0);
  });

  test('dragging the window scrubs through time without refetching', async ({ page }) => {
    await openApp(page);
    const requests = recordApiRequests(page);
    const track = await box(page, 'timeline-track');
    const win = await box(page, 'timeline-window');

    const y = win.y + win.height / 2;
    await page.mouse.move(win.x + win.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(win.x + win.width / 2 + track.width / 7, y, { steps: 12 }); // ≈ one day
    await page.mouse.up();

    const [start, end] = await trackWindow(page);
    expect(start).toBeGreaterThan(20 * H);
    expect(start).toBeLessThan(28 * H);
    expect(end - start).toBe(6 * H); // moved, not resized
    expect(requests).toHaveLength(0);
  });

  test('dragging a handle resizes the window', async ({ page }) => {
    await openApp(page);
    const track = await box(page, 'timeline-track');
    const handle = await box(page, 'timeline-handle-end');
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * (2 / 7), y, { steps: 8 });
    await page.mouse.up();
    const [start, end] = await trackWindow(page);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(40 * H);
  });

  test('exact UTC times can be typed', async ({ page }) => {
    await openApp(page);
    await page.getByLabel('Window end (UTC)').fill('2027-03-01T12:30');
    await expect(page.getByTestId('window-duration')).toHaveText('12 h 30 min');
    await expect.poll(() => trackWindow(page)).toEqual([0, 12.5 * H]);
  });

  test('play slides the window forward and pause stops it', async ({ page }) => {
    await openApp(page);
    await page.getByLabel('Playback speed').selectOption('3600');
    await page.getByRole('button', { name: 'Play' }).click();
    // Any forward movement proves the loop runs; software-rendered CI browsers draw few frames.
    await expect.poll(async () => (await trackWindow(page))[0], { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = (await hooks.state(page)).timeWindow;
    // Let 20 frames render: a still-running playback loop would have moved the window.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const step = () => {
            frames += 1;
            if (frames >= 20) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    expect((await hooks.state(page)).timeWindow).toEqual(paused);
  });

  test('arrow keys nudge the window', async ({ page }) => {
    await openApp(page);
    await page.locator('body').press('Shift+ArrowRight');
    await expect.poll(() => trackWindow(page)).toEqual([6 * H, 12 * H]);
    await page.locator('body').press('ArrowLeft');
    await expect.poll(async () => (await trackWindow(page))[0]).toBeCloseTo(6 * H - 0.6 * H, 0);
    expect((await hooks.state(page)).playing).toBe(false);
  });
});
