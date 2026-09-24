import { describe, expect, it } from 'vitest';

import { splitAtAntimeridian, type TrackBuffers } from '../tracks/trackBuffers';

import { assignColors, hexToRgb, SATELLITE_PALETTE } from './colors';
import { nearestOnPath, sampleTrack } from './trackQueries';

const T0 = 1_000_000;

function track(lon: number[], lat: number[], startS = T0, stepS = 10): TrackBuffers {
  return {
    satellite: 'S',
    startS,
    stepS,
    lon: Float32Array.from(lon),
    lat: Float32Array.from(lat),
    altKm: Float32Array.from(lon.map((_, i) => 500 + i)),
    ...splitAtAntimeridian({ lon, lat, t0RelS: startS - T0, stepS }),
  };
}

describe('sampleTrack', () => {
  const t = track([0, 1, 2], [0, 2, 4]);

  it('interpolates position and altitude between vertices', () => {
    expect(sampleTrack(t, T0 + 5)).toEqual({ lon: 0.5, lat: 1, altKm: 500.5 });
    expect(sampleTrack(t, T0 + 20)).toEqual({ lon: 2, lat: 4, altKm: 502 });
    expect(sampleTrack(t, T0)).toEqual({ lon: 0, lat: 0, altKm: 500 });
  });

  it('returns null outside the track span or for an empty track', () => {
    expect(sampleTrack(t, T0 - 1)).toBeNull();
    expect(sampleTrack(t, T0 + 20.5)).toBeNull();
    expect(sampleTrack(track([], []), T0)).toBeNull();
  });

  it('handles a single-vertex track', () => {
    expect(sampleTrack(track([7], [8]), T0)).toEqual({ lon: 7, lat: 8, altKm: 500 });
  });

  it('interpolates across the antimeridian the short way', () => {
    const across = track([179, -179], [0, 0]);
    expect(sampleTrack(across, T0 + 2.5)!.lon).toBeCloseTo(179.5, 4);
    expect(sampleTrack(across, T0 + 7.5)!.lon).toBeCloseTo(-179.5, 4);
  });
});

describe('nearestOnPath', () => {
  // Due north along lon 10, one degree per 10 s.
  const t = track([10, 10, 10, 10], [0, 1, 2, 3]);
  const all = [0, 30] as const;

  it('projects the pointer onto the closest segment and interpolates its time', () => {
    const hit = nearestOnPath(t, { pathIndex: 0, lon: 10.2, lat: 1.5, windowRelS: all });
    expect(hit!.timeRelS).toBeCloseTo(15, 6);
    expect(hit!.dist2).toBeCloseTo(0.04 * Math.cos((1.5 * Math.PI) / 180) ** 2, 6);
  });

  it('clamps to the ends of the path', () => {
    expect(nearestOnPath(t, { pathIndex: 0, lon: 10, lat: -5, windowRelS: all })!.timeRelS).toBe(0);
    expect(nearestOnPath(t, { pathIndex: 0, lon: 10, lat: 9, windowRelS: all })!.timeRelS).toBe(30);
  });

  it('only considers the visible part of the path', () => {
    const hit = nearestOnPath(t, { pathIndex: 0, lon: 10, lat: 0, windowRelS: [12, 25] });
    expect(hit!.timeRelS).toBeCloseTo(12, 6);
    expect(nearestOnPath(t, { pathIndex: 0, lon: 10, lat: 0, windowRelS: [100, 200] })).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(nearestOnPath(t, { pathIndex: 5, lon: 10, lat: 0, windowRelS: all })).toBeNull();
  });

  it('searches only the picked path of a track split at the antimeridian', () => {
    const across = track([178, 179, -179, -178], [0, 0, 0, 0]);
    const east = nearestOnPath(across, { pathIndex: 1, lon: -178.5, lat: 0, windowRelS: all });
    expect(east!.timeRelS).toBeCloseTo(25, 4);
    // Near the edge, the pointer at -179.9 is 0.1° from the western path's +180 vertex.
    const west = nearestOnPath(across, { pathIndex: 0, lon: -179.9, lat: 0, windowRelS: all });
    expect(west!.timeRelS).toBeCloseTo(15, 4);
  });

  it('skips zero-length segments', () => {
    const still = track([5, 5], [5, 5]);
    expect(nearestOnPath(still, { pathIndex: 0, lon: 5, lat: 5, windowRelS: all })!.timeRelS).toBe(0);
  });
});

describe('colors', () => {
  it('parses hex colors', () => {
    expect(hexToRgb('#22d3ee')).toEqual([0x22, 0xd3, 0xee]);
  });

  it('assigns palette colors in list order and cycles past the palette', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const colors = assignColors(ids);
    expect(colors.get('S0')!.hex).toBe(SATELLITE_PALETTE[0]);
    expect(colors.get('S10')!.hex).toBe(SATELLITE_PALETTE[0]);
    expect(new Set(ids.slice(0, 10).map((id) => colors.get(id)!.hex)).size).toBe(10);
  });
});
