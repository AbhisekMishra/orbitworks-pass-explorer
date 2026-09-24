import { decodeTracks, encodeTracks } from '@ow/shared';
import { describe, expect, it } from 'vitest';

import {
  POSITION_SIZE,
  RENDER_ALTITUDE_M,
  buildTrackBuffers,
  splitAtAntimeridian,
  transferablesOf,
  type SplitTrack,
} from './trackBuffers';

type Vertex = [lon: number, lat: number, t: number];

const pathsOf = (r: SplitTrack): Vertex[][] => {
  const count = r.times.length;
  return Array.from(r.startIndices, (start, p) => {
    const end = r.startIndices[p + 1] ?? count;
    const path: Vertex[] = [];
    for (let v = start; v < end; v++) {
      expect(r.positions[POSITION_SIZE * v + 2]).toBe(RENDER_ALTITUDE_M);
      path.push([r.positions[POSITION_SIZE * v]!, r.positions[POSITION_SIZE * v + 1]!, r.times[v]!]);
    }
    return path;
  });
};

describe('splitAtAntimeridian', () => {
  it('keeps a track that never crosses as one path with relative times', () => {
    const r = splitAtAntimeridian({ lon: [10, 11, 12], lat: [0, 1, 2], t0RelS: 100, stepS: 10 });
    expect(pathsOf(r)).toEqual([
      [
        [10, 0, 100],
        [11, 1, 110],
        [12, 2, 120],
      ],
    ]);
  });

  it('splits an eastward crossing with interpolated edge vertices on both sides', () => {
    // 179 → -179 is a 2° eastward step: the edge is reached halfway, in space and in time.
    const r = splitAtAntimeridian({
      lon: [178, 179, -179, -178],
      lat: [0, 10, 20, 30],
      t0RelS: 0,
      stepS: 10,
    });
    expect(pathsOf(r)).toEqual([
      [
        [178, 0, 0],
        [179, 10, 10],
        [180, 15, 15],
      ],
      [
        [-180, 15, 15],
        [-179, 20, 20],
        [-178, 30, 30],
      ],
    ]);
  });

  it('splits a westward crossing', () => {
    const paths = pathsOf(splitAtAntimeridian({ lon: [-179.5, 179.5], lat: [0, 1], t0RelS: 0, stepS: 10 }));
    expect(paths).toHaveLength(2);
    expect(paths[0]!.at(-1)).toEqual([-180, 0.5, 5]);
    expect(paths[1]![0]).toEqual([180, 0.5, 5]);
  });

  it('handles several crossings and keeps times monotonic', () => {
    const lon = [170, -170, -150, 170, 150, -170];
    const r = splitAtAntimeridian({ lon, lat: lon.map(() => 0), t0RelS: 0, stepS: 10 });
    expect(r.startIndices).toHaveLength(4); // 3 crossings
    expect(r.times).toHaveLength(lon.length + 6);
    for (let i = 1; i < r.times.length; i++) expect(r.times[i]!).toBeGreaterThanOrEqual(r.times[i - 1]!);
  });

  it('does not split large steps that stay within half the globe', () => {
    const r = splitAtAntimeridian({ lon: [-90, 89], lat: [0, 0], t0RelS: 0, stepS: 10 });
    expect(r.startIndices).toHaveLength(1);
  });

  it('returns no paths for an empty track and one path for a single vertex', () => {
    expect(splitAtAntimeridian({ lon: [], lat: [], t0RelS: 0, stepS: 10 }).startIndices).toHaveLength(0);
    expect(
      Array.from(splitAtAntimeridian({ lon: [5], lat: [5], t0RelS: 0, stepS: 10 }).startIndices),
    ).toEqual([0]);
  });
});

describe('buildTrackBuffers', () => {
  const stream = encodeTracks(
    [
      { satellite: 'A', startS: 1000, lon: [179, -179, -178], lat: [0, 0, 0], altKm: [500, 501, 502] },
      { satellite: 'B', startS: 1010, lon: [0, 1], lat: [0, 1], altKm: [500, 500] },
      { satellite: 'EMPTY', startS: 0, lon: [], lat: [], altKm: [] },
    ],
    { stepS: 10 },
  );

  it('computes the dataset span from non-empty tracks and relative GPU times', () => {
    const loaded = buildTrackBuffers(decodeTracks(stream));
    expect(loaded).toMatchObject({ t0S: 1000, t1S: 1020, stepS: 10 });
    const b = loaded.tracks[1]!;
    expect(Array.from(b.times)).toEqual([10, 20]);
    expect(b.altKm[0]).toBeCloseTo(500, 5);
    expect(loaded.tracks[0]!.startIndices).toHaveLength(2);
    expect(loaded.tracks[2]!.positions).toHaveLength(0);
  });

  it('lists every buffer for zero-copy transfer', () => {
    expect(transferablesOf(buildTrackBuffers(decodeTracks(stream)))).toHaveLength(3 * 6);
  });

  it('returns an empty span for a dataset with no vertices', () => {
    expect(buildTrackBuffers(decodeTracks(encodeTracks([], { stepS: 10 })))).toMatchObject({
      t0S: 0,
      t1S: 0,
      tracks: [],
    });
  });
});
