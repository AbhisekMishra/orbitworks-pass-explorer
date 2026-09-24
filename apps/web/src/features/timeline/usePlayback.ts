import { MS_PER_SECOND } from '@ow/shared';
import { useEffect } from 'react';

import { useAppStore } from '../../state/store';

/** Longest frame gap applied at once: a backgrounded tab resumes smoothly instead of jumping. */
export const MAX_FRAME_S = 0.25;

/** Drives the playing window from requestAnimationFrame (wall-clock based, frame-rate independent). */
export function usePlayback(): void {
  const playing = useAppStore((s) => s.playing);
  const tick = useAppStore((s) => s.tick);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      // The first frame's timestamp can predate the effect's performance.now(): never step back.
      tick(Math.max(0, Math.min((now - last) / MS_PER_SECOND, MAX_FRAME_S)));
      last = now;
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing, tick]);
}
