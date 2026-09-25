/**
 * Shared E2E setup. The public basemap (OpenFreeMap) is replaced by a local blank style so tests
 * are hermetic and fast; everything else (API, worker, WebGL) is the real production build.
 */
import { test as base, expect, type Page, type Request } from '@playwright/test';

import type { E2EHooks } from '../src/testing/e2eHooks';

export const BLANK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#161d2e' } }],
};

type Snapshot<K extends 'state' | 'layers' | 'trackPoint'> = ReturnType<E2EHooks[K]>;

export const hooks = {
  state: (page: Page): Promise<Snapshot<'state'>> => page.evaluate(() => window.__OW_E2E__!.state()),
  layers: (page: Page): Promise<Snapshot<'layers'>> => page.evaluate(() => window.__OW_E2E__!.layers()),
  trackPoint: (page: Page): Promise<Snapshot<'trackPoint'>> =>
    page.evaluate(() => window.__OW_E2E__!.trackPoint()),
};

/** Satellites with at least one visible track chunk (layer ids are "track:<satellite>:<chunk>"). */
export async function visibleSatellites(page: Page): Promise<string[]> {
  const layers = await hooks.layers(page);
  const ids = layers
    .filter((l) => l.id.startsWith('track:') && l.visible)
    .map((l) => l.id.split(':')[1] ?? '');
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Resolves once the tracks are decoded and handed to deck.gl. */
export async function waitForTracks(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.__OW_E2E__?.layers().length ?? 0) > 0, undefined, {
    timeout: 20_000,
  });
}

/** Opens the app (optionally with a query string) with the first-run hint already dismissed. */
export async function openApp(page: Page, query = ''): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('ow.firstRunHint.v1', 'dismissed');
  });
  await page.goto(`/${query}`);
  await waitForTracks(page);
}

/** Records API requests made from now on (page and workers). */
export function recordApiRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) seen.push(r);
  });
  return seen;
}

export const test = base.extend({
  // Playwright names this callback `use`; renamed so the React hooks lint rule does not misfire.
  page: async ({ page }, provide) => {
    await page.route('https://tiles.openfreemap.org/**', (route) =>
      route.request().url().includes('/styles/')
        ? route.fulfill({ json: BLANK_STYLE })
        : route.fulfill({ status: 204 }),
    );
    await provide(page);
  },
});

export { expect };
export type { Page };

/** The projection MapLibre is actually rendering (not just the app state). */
export const mapProjection = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => {
    const type = window.__OW_E2E__?.map.getProjection().type;
    return typeof type === 'string' ? type : undefined;
  });

/** A pixel counts as coloured when its channels spread this much (the test basemap is grey-blue). */
const MIN_CHANNEL_SPREAD = 80;
/** Coloured pixels expected from ten tracks in the default window (a single track draws thousands). */
export const MIN_TRACK_PIXELS = 1000;

/**
 * Pixels drawn in a satellite colour on the next frame. Read in MapLibre's 'render' event, while
 * the WebGL drawing buffer (deck.gl layers included, interleaved) is still intact.
 */
export const colouredPixels = (page: Page): Promise<number> =>
  page.evaluate(
    (minSpread) =>
      new Promise<number>((resolve) => {
        const map = window.__OW_E2E__!.map;
        map.once('render', () => {
          const source = map.getCanvas();
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          const context = copy.getContext('2d');
          if (!context) {
            resolve(0);
            return;
          }
          context.drawImage(source, 0, 0);
          const { data } = context.getImageData(0, 0, copy.width, copy.height);
          let count = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;
            if (Math.max(r, g, b) - Math.min(r, g, b) > minSpread) count++;
          }
          resolve(count);
        });
        map.triggerRepaint();
      }),
    MIN_CHANNEL_SPREAD,
  );
