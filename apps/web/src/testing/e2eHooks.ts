/**
 * Read-only introspection for the Playwright suite (and for debugging in `vite dev`). Loaded only
 * in dev and `--mode e2e` builds: the import sits behind `import.meta.env.DEV || MODE === 'e2e'`,
 * which production builds replace with `false`, so this module is not even emitted there. WebGL output cannot be asserted from the DOM, so tests
 * read the layer props deck.gl was given and project coordinates to screen pixels instead.
 */
import type { MapController } from '../map/mapController';
import { sampleTrack } from '../map/trackQueries';
import { appStore } from '../state/store';
import type { LoadedTracks } from '../tracks/trackBuffers';

export interface LayerSnapshot {
  id: string;
  visible: boolean;
  opacity: number;
  windowStartRelS: number | undefined;
  windowEndRelS: number | undefined;
}

export interface E2EHooks {
  map: MapController['map'];
  state: () => {
    hidden: string[];
    timeWindow: { startS: number; endS: number };
    projection: string;
    playing: boolean;
    t0S: number | null;
  };
  layers: () => LayerSnapshot[];
  styleLoaded: () => boolean;
  /**
   * A point on a visible track inside the current window that lands inside the map container,
   * at least ISOLATION_PX away from every other satellite's samples (so hovering it can only pick
   * that satellite), in page coordinates; null when none is on screen.
   */
  trackPoint: () => { x: number; y: number; satellite: string; timeS: number } | null;
}

declare global {
  interface Window {
    __OW_E2E__?: E2EHooks;
  }
}

const MARGIN_PX = 40;
const SAMPLES_PER_TRACK = 60;
const ISOLATION_PX = 30;

export function installE2EHooks(controller: MapController, getTracks: () => LoadedTracks | null): void {
  window.__OW_E2E__ = {
    map: controller.map,
    state: () => {
      const s = appStore.getState();
      return {
        hidden: [...s.hidden],
        timeWindow: s.timeWindow,
        projection: s.projection,
        playing: s.playing,
        t0S: getTracks()?.t0S ?? null,
      };
    },
    layers: () =>
      controller.layers().map((l) => {
        const props = l.props as {
          visible: boolean;
          opacity: number;
          windowStartRelS?: number;
          windowEndRelS?: number;
        };
        return {
          id: l.id,
          visible: props.visible,
          opacity: props.opacity,
          windowStartRelS: props.windowStartRelS,
          windowEndRelS: props.windowEndRelS,
        };
      }),
    styleLoaded: () => controller.map.isStyleLoaded() === true,
    trackPoint: () => {
      const tracks = getTracks();
      if (!tracks) return null;
      const { timeWindow: w, hidden } = appStore.getState();
      const rect = controller.map.getContainer().getBoundingClientRect();
      const samples = tracks.tracks
        .filter((t) => !hidden.has(t.satellite))
        .flatMap((track) =>
          Array.from({ length: SAMPLES_PER_TRACK - 1 }, (_, k) => {
            const timeS = w.startS + ((w.endS - w.startS) * (k + 1)) / SAMPLES_PER_TRACK;
            const p = sampleTrack(track, timeS);
            if (!p) return null;
            const { x, y } = controller.map.project([p.lon, p.lat]);
            return { satellite: track.satellite, timeS, x, y };
          }),
        )
        .filter((s) => s !== null);
      const inside = (s: { x: number; y: number }) =>
        s.x > MARGIN_PX && s.y > MARGIN_PX && s.x < rect.width - MARGIN_PX && s.y < rect.height - MARGIN_PX;
      const isolated = samples.find(
        (s) =>
          inside(s) &&
          samples.every(
            (o) => o.satellite === s.satellite || Math.hypot(o.x - s.x, o.y - s.y) > ISOLATION_PX,
          ),
      );
      return isolated
        ? {
            x: rect.left + isolated.x,
            y: rect.top + isolated.y,
            satellite: isolated.satellite,
            timeS: isolated.timeS,
          }
        : null;
    },
  };
}
