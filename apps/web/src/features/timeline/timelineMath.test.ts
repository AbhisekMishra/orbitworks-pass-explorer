import { describe, expect, it } from 'vitest';

import {
  MIN_WINDOW_S,
  PRESETS,
  advanceWindow,
  applyPreset,
  centerWindowAt,
  clampWindow,
  fractionToTime,
  isPresetActive,
  moveWindowTo,
  resizeWindow,
  snap,
  timeTicks,
  timeToFraction,
} from './timelineMath';

const H = 3600;
const DAY = 86_400;
const T0 = Date.UTC(2027, 2, 1) / 1000; // a UTC midnight
const WEEK = { startS: T0, endS: T0 + 7 * DAY };
const preset = (label: string) => PRESETS.find((p) => p.label === label)!;

describe('clampWindow', () => {
  it('keeps a window that is already inside', () => {
    expect(clampWindow({ startS: T0 + H, endS: T0 + 2 * H }, WEEK)).toEqual({
      startS: T0 + H,
      endS: T0 + 2 * H,
    });
  });

  it('slides a window pushed past either edge back inside, keeping its span', () => {
    expect(clampWindow({ startS: T0 - H, endS: T0 + H }, WEEK)).toEqual({ startS: T0, endS: T0 + 2 * H });
    expect(clampWindow({ startS: WEEK.endS - H, endS: WEEK.endS + H }, WEEK)).toEqual({
      startS: WEEK.endS - 2 * H,
      endS: WEEK.endS,
    });
  });

  it('limits the span to [MIN_WINDOW_S, bounds]', () => {
    expect(clampWindow({ startS: T0, endS: T0 + 1 }, WEEK)).toEqual({ startS: T0, endS: T0 + MIN_WINDOW_S });
    expect(clampWindow({ startS: T0 - DAY, endS: T0 + 30 * DAY }, WEEK)).toEqual(WEEK);
    // An inverted window becomes the minimum span.
    expect(clampWindow({ startS: T0 + H, endS: T0 }, WEEK)).toEqual({
      startS: T0 + H,
      endS: T0 + H + MIN_WINDOW_S,
    });
  });

  it('shows a dataset shorter than the minimum span whole', () => {
    const tiny = { startS: T0, endS: T0 + 60 };
    expect(clampWindow({ startS: T0, endS: T0 + 10 }, tiny)).toEqual(tiny);
  });
});

describe('dragging', () => {
  const w = { startS: T0 + DAY, endS: T0 + DAY + 6 * H };

  it('moves and centers with the same span', () => {
    expect(moveWindowTo(w, T0 + 2 * DAY, WEEK)).toEqual({ startS: T0 + 2 * DAY, endS: T0 + 2 * DAY + 6 * H });
    expect(centerWindowAt(w, T0 + 3 * DAY, WEEK)).toEqual({
      startS: T0 + 3 * DAY - 3 * H,
      endS: T0 + 3 * DAY + 3 * H,
    });
    expect(centerWindowAt(w, T0, WEEK)).toEqual({ startS: T0, endS: T0 + 6 * H });
  });

  it('resizes one edge, never below the minimum span nor past the bounds', () => {
    expect(resizeWindow(w, 'start', T0 + DAY - H, WEEK)).toEqual({ startS: T0 + DAY - H, endS: w.endS });
    expect(resizeWindow(w, 'start', w.endS, WEEK)).toEqual({ startS: w.endS - MIN_WINDOW_S, endS: w.endS });
    expect(resizeWindow(w, 'start', T0 - DAY, WEEK).startS).toBe(T0);
    expect(resizeWindow(w, 'end', w.startS, WEEK)).toEqual({
      startS: w.startS,
      endS: w.startS + MIN_WINDOW_S,
    });
    expect(resizeWindow(w, 'end', T0 + 99 * DAY, WEEK).endS).toBe(WEEK.endS);
  });

  it('snaps to whole minutes', () => {
    expect(snap(T0 + 89)).toBe(T0 + 60);
    expect(snap(T0 + 91)).toBe(T0 + 120);
  });
});

describe('presets', () => {
  const w = { startS: T0 + DAY, endS: T0 + DAY + H };

  it('keeps the start and applies the span', () => {
    expect(applyPreset(w, preset('6 h'), WEEK)).toEqual({ startS: T0 + DAY, endS: T0 + DAY + 6 * H });
  });

  it('slides back when the span would pass the end', () => {
    const late = { startS: WEEK.endS - H, endS: WEEK.endS };
    expect(applyPreset(late, preset('1 d'), WEEK)).toEqual({ startS: WEEK.endS - DAY, endS: WEEK.endS });
  });

  it('"All" selects the whole dataset', () => {
    expect(applyPreset(w, preset('All'), WEEK)).toEqual(WEEK);
  });

  it('reports which preset is active', () => {
    expect(isPresetActive(w, preset('1 h'), WEEK)).toBe(true);
    expect(isPresetActive(w, preset('6 h'), WEEK)).toBe(false);
    expect(isPresetActive(WEEK, preset('All'), WEEK)).toBe(true);
    expect(isPresetActive(w, preset('All'), WEEK)).toBe(false);
    // On a dataset shorter than the preset, the preset equals the whole span.
    const short = { startS: T0, endS: T0 + 2 * H };
    expect(isPresetActive(short, preset('6 h'), short)).toBe(true);
  });
});

describe('advanceWindow', () => {
  it('moves forward and reports the end of the dataset', () => {
    const w = { startS: T0, endS: T0 + H };
    expect(advanceWindow(w, 60, WEEK)).toEqual({
      timeWindow: { startS: T0 + 60, endS: T0 + H + 60 },
      ended: false,
    });
    const end = advanceWindow({ startS: WEEK.endS - 2 * H, endS: WEEK.endS - H }, 2 * H, WEEK);
    expect(end).toEqual({ timeWindow: { startS: WEEK.endS - H, endS: WEEK.endS }, ended: true });
  });
});

describe('scale', () => {
  it('maps times to fractions and back, clamping outside [0, 1]', () => {
    expect(timeToFraction(T0 + 3.5 * DAY, WEEK)).toBe(0.5);
    expect(fractionToTime(0.5, WEEK)).toBe(T0 + 3.5 * DAY);
    expect(fractionToTime(-1, WEEK)).toBe(WEEK.startS);
    expect(fractionToTime(2, WEEK)).toBe(WEEK.endS);
  });
});

describe('timeTicks', () => {
  it('lists every UTC midnight and picks a readable hour step for the width', () => {
    const wide = timeTicks(WEEK, 7 * 24 * 30); // 30 px per hour
    expect(wide.hourStepS).toBe(H);
    expect(wide.days).toHaveLength(8);
    expect(wide.hours).toHaveLength(7 * 23);

    const narrow = timeTicks(WEEK, 700); // ~4 px per hour
    expect(narrow.hourStepS).toBe(12 * H);
    expect(narrow.days).toHaveLength(8);
    expect(narrow.hours).toHaveLength(7);
  });

  it('falls back to day ticks when even 12 h is too dense', () => {
    const t = timeTicks(WEEK, 100);
    expect(t.hourStepS).toBe(DAY);
    expect(t.days).toHaveLength(8);
    expect(t.hours).toHaveLength(0);
  });

  it('handles bounds that do not start on a tick', () => {
    const b = { startS: T0 + 30 * 60, endS: T0 + DAY + 30 * 60 };
    const t = timeTicks(b, 24 * 30);
    expect(t.days).toEqual([T0 + DAY]);
    expect(t.hours[0]).toBe(T0 + H);
  });

  it('handles an empty span', () => {
    expect(timeTicks({ startS: T0, endS: T0 }, 500)).toEqual({ days: [T0], hours: [], hourStepS: DAY });
  });
});
