import { describe, expect, it } from 'vitest';

import { POSITION_SIZE, splitAtAntimeridian } from '../tracks/trackBuffers';

import { chunkOverlaps, chunkTrack } from './trackChunks';

// One vertex every 10 s, chunks of 60 s: vertex i is at t = 10·i.
const track = (lon: number[], t0RelS = 0) =>
  splitAtAntimeridian({ lon, lat: lon.map(() => 0), t0RelS, stepS: 10 });
const lons = (n: number) => Array.from({ length: n }, (_, i) => i * 0.5);

describe('chunkTrack', () => {
  it('covers every segment exactly once, sharing one vertex between neighbours', () => {
    const t = track(lons(20)); // t = 0…190
    const chunks = chunkTrack(t, 60);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => [c.startRelS, c.endRelS])).toEqual([
      [0, 50],
      [50, 110],
      [110, 170],
      [170, 190],
    ]);
    // Segments per chunk add up to the track's: nothing missing, nothing drawn twice.
    const segments = chunks.reduce((sum, c) => sum + c.times.length - 1, 0);
    expect(segments).toBe(t.times.length - 1);
  });

  it('returns views into the track buffers, not copies', () => {
    const t = track(lons(20));
    const [, second] = chunkTrack(t, 60);
    expect(second!.times.buffer).toBe(t.times.buffer);
    expect(second!.positions.buffer).toBe(t.positions.buffer);
    expect(second!.positions).toHaveLength(second!.times.length * POSITION_SIZE);
    expect(second!.positions[0]).toBe(t.positions[5 * POSITION_SIZE]); // starts at vertex 5 (t = 50)
  });

  it('rebases antimeridian path starts into each chunk', () => {
    // Crossing between vertices 7 and 8 (t = 70…80) splits the track into two paths.
    const lon = [170, 172, 174, 176, 178, 179, 179.5, 179.9, -179.9, -179.5, -179, -178];
    const t = track(lon);
    expect(Array.from(t.startIndices)).toEqual([0, 9]);
    const chunks = chunkTrack(t, 60);
    expect(chunks.map((c) => Array.from(c.startIndices))).toEqual([[0], [0, 4]]);
    // In the second chunk the new path starts on the -180 edge vertex.
    const second = chunks[1]!;
    expect(second.positions[4 * POSITION_SIZE]).toBe(-180);
  });

  it('starts at the chunk holding the first vertex for tracks that begin late', () => {
    const chunks = chunkTrack(track(lons(4), 130), 60); // t = 130…160
    expect(chunks.map((c) => [c.index, c.startRelS, c.endRelS])).toEqual([[2, 130, 170 - 10]]);
  });

  it('skips chunks without a segment and handles tiny tracks', () => {
    expect(chunkTrack(track([]), 60)).toEqual([]);
    expect(chunkTrack(track([1]), 60)).toEqual([]);
    // Two vertices 10 s apart that straddle a boundary land in the later chunk only.
    const chunks = chunkTrack(track([0, 1], 55), 60);
    expect(chunks.map((c) => c.index)).toEqual([1]);
  });
});

describe('chunkOverlaps', () => {
  const [chunk] = chunkTrack(track(lons(7)), 60); // t = 0…60 → covers 0…50
  it('tests the actual coverage against the window, inclusive', () => {
    expect(chunkOverlaps(chunk!, 50, 100)).toBe(true);
    expect(chunkOverlaps(chunk!, 51, 100)).toBe(false);
    expect(chunkOverlaps(chunk!, -10, 0)).toBe(true);
    expect(chunkOverlaps(chunk!, -10, -1)).toBe(false);
  });
});
