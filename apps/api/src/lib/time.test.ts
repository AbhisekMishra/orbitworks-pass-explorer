import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isoSeconds, roundToSecond } from './time.js';

/** The reference: what isoSeconds must always equal. */
const reference = (ms: number) => new Date(roundToSecond(ms)).toISOString().replace('.000Z', 'Z');

describe('isoSeconds', () => {
  it('formats UTC with second precision and no milliseconds', () => {
    expect(isoSeconds(Date.UTC(2027, 2, 1, 6, 57, 59))).toBe('2027-03-01T06:57:59Z');
    expect(isoSeconds(Date.UTC(2027, 2, 1, 6, 57, 59, 499))).toBe('2027-03-01T06:57:59Z');
    expect(isoSeconds(Date.UTC(2027, 2, 1, 6, 57, 59, 500))).toBe('2027-03-01T06:58:00Z');
  });

  it('rolls over midnight, month, year and leap day like toISOString', () => {
    for (const ms of [
      Date.UTC(2027, 2, 1, 23, 59, 59, 600),
      Date.UTC(2027, 11, 31, 23, 59, 59, 999),
      Date.UTC(2028, 1, 29, 12, 0, 0),
      0,
      -1,
      -86_400_000 - 500,
    ]) {
      expect(isoSeconds(ms)).toBe(reference(ms));
    }
  });

  it('equals the Date-based reference for any instant (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2_000_000_000_000, max: 4_000_000_000_000 }), (ms) => {
        expect(isoSeconds(ms)).toBe(reference(ms));
      }),
      { numRuns: 5000 },
    );
  });

  it('keeps giving correct results once its day cache has been cleared', () => {
    const day = 86_400_000;
    for (let i = 0; i < 200; i++) expect(isoSeconds(i * day + 1000)).toBe(reference(i * day + 1000));
  });
});
