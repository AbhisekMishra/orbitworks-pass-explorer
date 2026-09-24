import { useEffect } from 'react';

import { defaultWindow } from '../features/timeline/timelineMath';
import { sameItems } from '../lib/equality';

import { appStore, type AppState } from './store';
import { serializeUrlState } from './url';

/** Coalesces bursts (dragging, zooming) into one history write. */
export const URL_WRITE_DELAY_MS = 250;

export function urlFor(s: AppState): string | null {
  if (!s.bounds) return null;
  return serializeUrlState({
    satellites: s.satellites,
    hidden: s.hidden,
    timeWindow: s.timeWindow,
    defaultWindow: defaultWindow(s.bounds),
    projection: s.projection,
    camera: s.camera,
  });
}

/**
 * Mirrors the shareable state into the address bar (replaceState: no history spam). Skipped while
 * playing — the window moves every frame — and written once playback stops.
 */
export function useUrlSync(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = (): void => {
      const s = appStore.getState();
      const qs = urlFor(s);
      if (qs === null || s.playing) return;
      const next = `${window.location.pathname}${qs}${window.location.hash}`;
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(window.history.state, '', next);
      }
    };
    const unsubscribe = appStore.subscribe(
      // While playing the window moves every frame and nothing is written: leave it out then.
      (s) =>
        [s.bounds, s.hidden, s.playing ? null : s.timeWindow, s.projection, s.camera, s.playing] as const,
      () => {
        clearTimeout(timer);
        timer = setTimeout(write, URL_WRITE_DELAY_MS);
      },
      { equalityFn: sameItems },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
}
