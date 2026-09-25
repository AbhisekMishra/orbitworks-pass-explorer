import { encodeTracks } from '@ow/shared';
import { describe, expect, it, vi } from 'vitest';

import { fetchTracks } from './fetchTracks';

const URL_ = 'https://api.example/api/v1/tracks/binary';
const stream = encodeTracks([{ satellite: 'A', startS: 1000, lon: [0, 1], lat: [0, 1], altKm: [500, 500] }], {
  stepS: 10,
});
const ok = (body: BodyInit) => vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

describe('fetchTracks (decode worker logic)', () => {
  it('decodes the stream into transferable GPU buffers, asking for the binary media type', async () => {
    const fetchFn = ok(new Uint8Array(stream));
    const { response, transfer } = await fetchTracks(URL_, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(URL_, {
      headers: { accept: 'application/vnd.orbitworks.tracks+octet-stream' },
    });
    expect(response.type).toBe('done');
    if (response.type !== 'done') return;
    expect(response.tracks.tracks.map((t) => t.satellite)).toEqual(['A']);
    expect(response.stats.rawBytes).toBe(stream.byteLength);
    expect(response.stats.transferBytes).toBeNull(); // no Resource Timing entry in tests
    expect(transfer).toHaveLength(6);
  });

  it('reports the compressed size from Resource Timing when the browser exposes it', async () => {
    // A real entry cannot be constructed; an object with its prototype passes the instanceof check.
    const entry: unknown = Object.create(PerformanceResourceTiming.prototype, {
      encodedBodySize: { value: 1234 },
    });
    const spy = vi.spyOn(performance, 'getEntriesByName').mockReturnValue([entry as PerformanceEntry]);
    const { response } = await fetchTracks(URL_, ok(new Uint8Array(stream)));
    spy.mockRestore();
    expect(response.type === 'done' && response.stats.transferBytes).toBe(1234);
  });

  it('reports HTTP errors with their status', async () => {
    const { response } = await fetchTracks(
      URL_,
      vi.fn().mockResolvedValue(new Response('', { status: 503 })),
    );
    expect(response).toEqual({ type: 'error', status: 503, message: expect.stringContaining('HTTP 503') });
  });

  it('reports an unreachable server', async () => {
    const { response } = await fetchTracks(URL_, vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(response).toMatchObject({
      type: 'error',
      status: 0,
      message: expect.stringContaining('could not be reached'),
    });
  });

  it('reports a body that fails mid-download instead of hanging', async () => {
    const res = new Response('partial', { status: 200 });
    vi.spyOn(res, 'arrayBuffer').mockRejectedValue(new TypeError('network error'));
    const { response } = await fetchTracks(URL_, vi.fn().mockResolvedValue(res));
    expect(response).toMatchObject({ type: 'error', status: 0 });
  });

  it('reports corrupt data', async () => {
    const { response, transfer } = await fetchTracks(URL_, ok('not a track stream'));
    expect(response).toMatchObject({ type: 'error', message: expect.stringContaining('corrupt') });
    expect(transfer).toEqual([]);
  });
});
