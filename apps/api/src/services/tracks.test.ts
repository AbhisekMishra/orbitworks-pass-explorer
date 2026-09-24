import { TracksGeoJsonSchema, decodeTracks } from '@ow/shared';
import { describe, expect, it } from 'vitest';

import { T0, makeTrack } from '../../test/synthetic.js';
import { geometryFromSegments } from '../../test/geometry.js';

import { encodeSegments, segmentsToGeoJson, selectSegments, trackInputs } from './tracks.js';

const a = makeTrack({ satellite: 'A', startMs: T0, lon: 0, lat: 0, bearing: 0, minutes: 3 });
const aAfterGap = makeTrack({
  satellite: 'A',
  startMs: T0 + 10 * 60_000,
  lon: 5,
  lat: 0,
  bearing: 0,
  minutes: 1,
});
const b = makeTrack({ satellite: 'B', startMs: T0, lon: 9, lat: 0, bearing: 0, minutes: 2 });
const geometry = geometryFromSegments([...a, ...aAfterGap, ...b]);

describe('selectSegments', () => {
  it('filters by satellite and by overlap with the time window', () => {
    expect(selectSegments(geometry, {})).toEqual([0, 1, 2, 3, 4, 5]);
    expect(selectSegments(geometry, { satellites: ['B'] })).toEqual([4, 5]);
    expect(selectSegments(geometry, { startMs: T0 + 60_000, endMs: T0 + 120_000 })).toEqual([1, 5]);
    expect(selectSegments(geometry, { startMs: T0 + 30 * 60_000 })).toEqual([]);
  });
});

describe('trackInputs', () => {
  it('joins contiguous segments without duplicating shared vertices, and splits at gaps', () => {
    const tracks = trackInputs(geometry, selectSegments(geometry, {}));
    expect(tracks.map((t) => [t.satellite, t.startS, t.lon.length])).toEqual([
      ['A', T0 / 1000, 3 * 6 + 1],
      ['A', (T0 + 10 * 60_000) / 1000, 7],
      ['B', T0 / 1000, 2 * 6 + 1],
    ]);
    expect(tracks[0]?.lat[18]).toBe(a[2]?.coords[6]?.[1]);
  });

  it('returns no tracks for no segments', () => {
    expect(trackInputs(geometry, [])).toEqual([]);
  });
});

describe('encodeSegments / segmentsToGeoJson', () => {
  it('encodes the selection to a decodable OWT1 stream', () => {
    const { tracks } = decodeTracks(encodeSegments(geometry, [4, 5], 10));
    expect(tracks.map((t) => [t.satellite, t.lon.length])).toEqual([['B', 13]]);
  });

  it('mirrors the source segments as GeoJSON features', () => {
    const fc = TracksGeoJsonSchema.parse(segmentsToGeoJson(geometry, [0]));
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]?.properties).toEqual({
      satellite: 'A',
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-01T00:01:00Z',
    });
    expect(fc.features[0]?.geometry.coordinates[3]?.[1]).toBeCloseTo(a[0]!.coords[3]![1], 9);
  });
});
