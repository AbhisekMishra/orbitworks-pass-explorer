import { toLonLat } from '@ow/shared';
import { describe, expect, it } from 'vitest';

import { T0, makeTrack } from '../../test/synthetic.js';

import { geometryFromSegments } from '../../test/geometry.js';

import { MAX_ARC_KM, buildGeometry, vertexVec } from './geometry.js';

describe('buildGeometry', () => {
  it('lays out segments and vertices as indexed typed arrays', () => {
    const segments = [
      ...makeTrack({ satellite: 'A', startMs: T0, lon: 10, lat: 20, bearing: 45, minutes: 2 }),
      ...makeTrack({ satellite: 'B', startMs: T0, lon: -30, lat: -5, bearing: 90, minutes: 1 }),
    ];
    const g = geometryFromSegments(segments);

    expect(g.segmentCount).toBe(3);
    expect(g.satellites).toEqual(['A', 'B']);
    expect(Array.from(g.satelliteIndex)).toEqual([0, 0, 1]);
    expect(Array.from(g.vertexStart)).toEqual([0, 7, 14, 21]);
    expect(Array.from(g.startMs)).toEqual(segments.map((s) => s.startMs));

    // Unit vectors round-trip to the source coordinates; altitude is kept per vertex.
    const [lon, lat] = toLonLat(vertexVec(g, 9));
    expect(lon).toBeCloseTo(segments[1]!.coords[2]![0], 9);
    expect(lat).toBeCloseTo(segments[1]!.coords[2]![1], 9);
    expect(Math.hypot(...vertexVec(g, 9))).toBeCloseTo(1, 12);
    expect(g.altKm[9]).toBeCloseTo(segments[1]!.coords[2]![2], 3);
  });

  it('rejects vertex counts that do not match the flattened columns', () => {
    expect(() =>
      buildGeometry({
        satellite: ['A'],
        startMs: [T0],
        endMs: [T0 + 60_000],
        vertexCount: [3],
        lon: [0, 1],
        lat: [0, 0],
        altKm: [500, 500],
      }),
    ).toThrow(/Vertex counts/);
  });

  it(`rejects arcs longer than ${MAX_ARC_KM} km (the engine's O(1) rejection relies on the bound)`, () => {
    expect(() =>
      buildGeometry({
        satellite: ['A'],
        startMs: [T0],
        endMs: [T0 + 10_000],
        vertexCount: [2],
        lon: [0, 3], // ≈ 334 km apart
        lat: [0, 0],
        altKm: [500, 500],
      }),
    ).toThrow(/longer than/);
  });
});
