import { describe, expect, it } from 'vitest';

import { formatBytes, formatLat, formatLon } from './format';

describe('format', () => {
  it('formats latitudes and longitudes with hemispheres', () => {
    expect(formatLat(24.4539)).toBe('24.45° N');
    expect(formatLat(-33.8688, 1)).toBe('33.9° S');
    expect(formatLon(54.3773)).toBe('54.38° E');
    expect(formatLon(-122.4)).toBe('122.40° W');
    expect(formatLat(0)).toBe('0.00° N');
  });

  it('formats byte sizes in decimal units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(780_400)).toBe('780 KB');
    expect(formatBytes(524_066)).toBe('524 KB');
    expect(formatBytes(2_097_152)).toBe('2.10 MB');
  });
});
