import { describe, expect, it } from 'vitest';

import { PASS_CONTEXT_S, clampDays, passWindow } from './accessWindow';

describe('clampDays', () => {
  const DAY = 86_400;
  const T0 = Date.UTC(2027, 2, 1) / 1000;
  const bounds = { startS: T0, endS: T0 + 7 * DAY };

  it('snaps to whole UTC days inside the dataset', () => {
    expect(clampDays(T0 + DAY + 3600, T0 + 3 * DAY - 60, bounds)).toEqual({
      startS: T0 + DAY,
      endS: T0 + 3 * DAY,
    });
    expect(clampDays(T0 - 5 * DAY, T0 + 30 * DAY, bounds)).toEqual(bounds);
  });

  it('keeps at least one day, even for an inverted range', () => {
    expect(clampDays(T0 + 3 * DAY, T0 + DAY, bounds)).toEqual({ startS: T0 + 3 * DAY, endS: T0 + 4 * DAY });
    expect(clampDays(T0 + 9 * DAY, T0 + 9 * DAY, bounds)).toEqual({
      startS: T0 + 6 * DAY,
      endS: T0 + 7 * DAY,
    });
  });
});

describe('passWindow', () => {
  it('adds context on both sides, at least PASS_CONTEXT_S, else the pass duration', () => {
    expect(passWindow(1000, 1100)).toEqual({ startS: 1000 - PASS_CONTEXT_S, endS: 1100 + PASS_CONTEXT_S });
    expect(passWindow(0, 2000)).toEqual({ startS: -2000, endS: 4000 });
  });
});
