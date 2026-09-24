import zlib from 'node:zlib';

import {
  AccessesResponseSchema,
  ApiErrorSchema,
  DatasetSchema,
  TracksGeoJsonSchema,
  decodeTracks,
  normalizeLon,
  slerp,
  sunElevationDeg,
  toLonLat,
  toVec,
  type Pass,
} from '@ow/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/database.js';
import type { Segment } from './geometry.js';

import { encodeArtifacts } from '../src/services/trackArtifacts.js';

import { createFixtureEnv, segmentsOf, testConfig, type FixtureEnv } from './fixture-env.js';
import { geometryFromSegments } from './geometry.js';
import { T0, makeTrack } from './synthetic.js';

const API = '/api/v1';
let env: FixtureEnv;
let app: FastifyInstance;
/** YAM20's 31st segment (00:30–00:31 UTC) and the vertex at 00:30:30, used as a known target. */
let knownSegment: Segment;

beforeAll(async () => {
  env = await createFixtureEnv();
  app = await env.app();
  knownSegment = segmentsOf(env.geometry, { satellites: ['YAM20'] })[30]!;
});
afterAll(async () => {
  await env.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const accesses = (params: Record<string, string | number | boolean>) =>
  get(
    `${API}/accesses?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString()}`,
  );

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await get('/readyz')).json()).toEqual({ status: 'ready' });
  });

  it('reports 503 when the database stops answering', async () => {
    const broken: Database = { ...env.db, ping: () => Promise.reject(new Error('down')) };
    const brokenApp = await buildApp({
      config: testConfig(),
      db: broken,
      geometry: env.geometry,
      info: env.info,
      artifacts: env.artifacts,
    });
    const res = await brokenApp.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await brokenApp.close();
  });
});

describe(`GET ${API}/dataset`, () => {
  it('describes the fixture and is cacheable', async () => {
    const res = await get(`${API}/dataset`);
    expect(res.statusCode).toBe(200);
    const body = DatasetSchema.parse(res.json());
    expect(body).toMatchObject({
      name: 'Fixture',
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-01T03:00:00Z',
      stepS: 10,
    });
    expect(body.satellites.map((s) => s.id)).toEqual(['YAM20', 'YAM25']);
    expect(res.headers.etag).toBe(env.artifacts.etag);
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const res = await get(`${API}/dataset`, { 'if-none-match': env.artifacts.etag });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
  });
});

describe(`GET ${API}/tracks/binary`, () => {
  it('serves the precompressed brotli artifact unchanged (no double compression)', async () => {
    const res = await get(`${API}/tracks/binary`, { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-encoding': 'br',
      'content-type': 'application/vnd.orbitworks.tracks+octet-stream',
      etag: env.artifacts.etag,
      vary: 'Accept-Encoding',
    });
    const raw = zlib.brotliDecompressSync(res.rawPayload);
    expect(Buffer.compare(raw, Buffer.from(env.artifacts.raw))).toBe(0);
    const { tracks } = decodeTracks(raw);
    expect(tracks.map((t) => [t.satellite, t.lon.length])).toEqual([
      ['YAM20', 180 * 6 + 1],
      ['YAM25', 180 * 6 + 1],
    ]);
  });

  it.each([
    ['gzip', 'gzip', (b: Buffer) => zlib.gunzipSync(b)],
    ['', undefined, (b: Buffer) => b],
  ])('negotiates Accept-Encoding "%s"', async (acceptEncoding, contentEncoding, decode) => {
    const res = await get(`${API}/tracks/binary`, { 'accept-encoding': acceptEncoding });
    expect(res.headers['content-encoding']).toBe(contentEncoding);
    expect(Buffer.compare(decode(res.rawPayload), Buffer.from(env.artifacts.raw))).toBe(0);
  });

  it('answers 406 when no offered encoding is acceptable', async () => {
    const res = await get(`${API}/tracks/binary`, { 'accept-encoding': 'identity;q=0' });
    expect(res.statusCode).toBe(406);
    expect(ApiErrorSchema.parse(res.json()).error).toBe('Not Acceptable');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const res = await get(`${API}/tracks/binary`, { 'if-none-match': env.artifacts.etag });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload).toHaveLength(0);
  });

  it('encodes filtered requests on demand', async () => {
    const res = await get(
      `${API}/tracks/binary?satellites=YAM25&start=2027-03-01T01:00:00Z&end=2027-03-01T01:10:00Z`,
    );
    expect(res.statusCode).toBe(200);
    const { tracks } = decodeTracks(res.rawPayload);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      satellite: 'YAM25',
      startS: Date.parse('2027-03-01T01:00:00Z') / 1000,
    });
    expect(tracks[0]!.lon).toHaveLength(10 * 6 + 1);
  });

  it.each([
    ['satellites=NOPE', /Unknown satellite/],
    ['start=2027-03-02&end=2027-03-01', /Invalid request parameters/],
  ])('rejects %s with 400', async (query, message) => {
    const res = await get(`${API}/tracks/binary?${query}`);
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).message).toMatch(message);
  });
});

describe(`GET ${API}/tracks/binary — caching and filters`, () => {
  it('sends no cache headers or ETag with a 406', async () => {
    const res = await get(`${API}/tracks/binary`, { 'accept-encoding': 'identity;q=0' });
    expect(res.statusCode).toBe(406);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBeUndefined();
  });

  it.each([
    ['a weak validator', (etag: string) => `W/${etag}`],
    ['a list of validators', (etag: string) => `"other", ${etag}`],
    ['the wildcard', () => '*'],
  ])('honours If-None-Match with %s', async (_label, header) => {
    const res = await get(`${API}/tracks/binary`, { 'if-none-match': header(env.artifacts.etag) });
    expect(res.statusCode).toBe(304);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves the precompressed artifact when the filters cover everything anyway', async () => {
    const res = await get(`${API}/tracks/binary?satellites=YAM25,YAM20&start=2020-01-01`, {
      'accept-encoding': 'br',
    });
    expect(res.headers.etag).toBe(env.artifacts.etag);
    expect(Buffer.compare(res.rawPayload, env.artifacts.brotli)).toBe(0);
  });

  it.each([
    ['gzip', (b: Buffer) => zlib.gunzipSync(b)],
    ['identity', (b: Buffer) => b],
  ])('compresses filtered streams itself (%s)', async (coding, decode) => {
    const res = await get(`${API}/tracks/binary?satellites=YAM20&end=2027-03-01T00:10:00Z`, {
      'accept-encoding': coding,
    });
    expect(res.headers['content-encoding']).toBe(coding === 'identity' ? undefined : coding);
    expect(res.headers.etag).toBeUndefined();
    const { tracks } = decodeTracks(decode(res.rawPayload));
    expect(tracks.map((t) => [t.satellite, t.lon.length])).toEqual([['YAM20', 10 * 6 + 1]]);
  });

  it('limits filtered slices to 24 hours (the full stream serves anything larger)', async () => {
    // The fixture spans 3 h, so this needs a longer dataset: 30 h of one synthetic satellite.
    const hours = 30;
    const geometry = geometryFromSegments(
      makeTrack({ satellite: 'L', startMs: T0, lon: 0, lat: 0, bearing: 45, minutes: hours * 60 }),
    );
    const encoded = await encodeArtifacts(geometry, 10);
    const endMs = T0 + hours * 3_600_000;
    const longApp = await buildApp({
      config: testConfig(),
      db: env.db,
      geometry,
      info: {
        name: 'Long',
        startMs: T0,
        endMs,
        stepS: 10,
        satellites: [
          { id: 'L', startMs: T0, endMs, segmentCount: hours * 60, minAltitudeKm: 500, maxAltitudeKm: 500 },
        ],
        satelliteIds: new Set(['L']),
      },
      artifacts: { ...encoded, manifest: { ...env.artifacts.manifest, etag: encoded.etag } },
    });
    const call = (query: string) => longApp.inject({ method: 'GET', url: `${API}/tracks/binary${query}` });
    const tooWide = await call('?start=2027-03-01T00:00:01Z'); // 30 h minus a second: not "everything"
    expect(tooWide.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(tooWide.json()).message).toMatch(/24 hours/);
    expect((await call('?start=2027-03-01T00:00:01Z&end=2027-03-02T00:00:01Z')).statusCode).toBe(200);
    expect((await call('')).headers.etag).toBe(encoded.etag); // no filter: the full stream
    await longApp.close();
  });

  it('is rate limited per client', async () => {
    const limited = await env.app({ RATE_LIMIT_TRACKS_PER_MIN: '1' });
    const call = () => limited.inject({ method: 'GET', url: `${API}/tracks/binary` });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
  });

  it('returns an empty stream for a window outside the dataset', async () => {
    const res = await get(`${API}/tracks/binary?start=2027-04-01&end=2027-04-02`);
    expect(res.statusCode).toBe(200);
    expect(decodeTracks(res.rawPayload).tracks).toEqual([]);
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: `${API}/tracks/binary`,
      headers: { 'accept-encoding': 'br' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(env.artifacts.etag);
    expect(res.rawPayload).toHaveLength(0);
  });
});

describe(`GET ${API}/tracks (GeoJSON)`, () => {
  it('returns one LineString per 1-minute segment in the window', async () => {
    const res = await get(
      `${API}/tracks?satellites=YAM20&start=2027-03-01T00:00:00Z&end=2027-03-01T01:00:00Z`,
    );
    expect(res.statusCode).toBe(200);
    const body = TracksGeoJsonSchema.parse(res.json());
    expect(body.features).toHaveLength(60);
    expect(body.features[0]?.properties).toEqual({
      satellite: 'YAM20',
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-01T00:01:00Z',
    });
    expect(body.features[0]?.geometry.coordinates).toHaveLength(7);
  });

  it('compresses dynamic JSON when the client accepts it', async () => {
    const res = await get(`${API}/tracks?start=2027-03-01T00:00:00Z&end=2027-03-01T01:00:00Z`, {
      'accept-encoding': 'br',
    });
    expect(res.headers['content-encoding']).toBe('br');
    expect(
      TracksGeoJsonSchema.parse(JSON.parse(zlib.brotliDecompressSync(res.rawPayload).toString())).features,
    ).toHaveLength(120);
  });

  it('rejects a window over 6 hours on the end field', async () => {
    const res = await get(`${API}/tracks?start=2027-03-01T00:00:00Z&end=2027-03-01T06:00:01Z`);
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).issues?.map((i) => i.path)).toContain('end');
  });

  it('requires a bounded window and points to the binary endpoint', async () => {
    const res = await get(`${API}/tracks`);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/tracks\/binary/);
  });
});

describe(`GET ${API}/accesses`, () => {
  const target = () => {
    const [lon, lat] = knownSegment.coords[3]!;
    return { lon, lat, tcaMs: knownSegment.startMs + 30_000 };
  };

  it('finds the overhead pass over a point on the track, with a valid contract', async () => {
    const { lon, lat, tcaMs } = target();
    const res = await accesses({ lat, lon, radiusKm: 100 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['server-timing']).toMatch(/^compute;dur=/);
    const body = AccessesResponseSchema.parse(res.json());
    const pass = body.passes.find(
      (p) => p.satellite === 'YAM20' && Math.abs(Date.parse(p.tca) - tcaMs) < 5000,
    );
    expect(pass).toBeDefined();
    expect(pass!.minDistanceKm).toBeLessThan(1);
    expect(pass!.maxElevationDeg).toBeGreaterThan(89);
    expect(body.query).toMatchObject({
      radiusKm: 100,
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-01T03:00:00Z',
      satellites: ['YAM20', 'YAM25'],
      daylightOnly: false,
      includePath: false,
    });
    expect(Object.keys(body.stats.bySatellite)).toEqual(['YAM20', 'YAM25']);
    expect(body.stats.passCount).toBe(body.passes.length);
  });

  it('clamps the window to the dataset and returns nothing outside it', async () => {
    const { lon, lat } = target();
    const early = AccessesResponseSchema.parse(
      (await accesses({ lat, lon, start: '2027-02-01', end: '2027-03-01T01:00:00Z' })).json(),
    );
    expect(early.query.start).toBe('2027-03-01T00:00:00Z');
    const outside = AccessesResponseSchema.parse(
      (await accesses({ lat, lon, start: '2027-04-01', end: '2027-04-02' })).json(),
    );
    expect(outside.passes).toEqual([]);
    expect(outside.stats.passCount).toBe(0);
  });

  it('filters by satellite', async () => {
    const { lon, lat } = target();
    const body = AccessesResponseSchema.parse(
      (await accesses({ lat, lon, radiusKm: 100, satellites: 'YAM25' })).json(),
    );
    expect(body.passes.every((p: Pass) => p.satellite === 'YAM25')).toBe(true);
    expect(body.query.satellites).toEqual(['YAM25']);
  });

  it('filters to daylight passes on request, consistent with the Sun elevation', async () => {
    const { lon, lat, tcaMs } = target();
    const lit = sunElevationDeg(tcaMs, lon, lat) > 0;
    const body = AccessesResponseSchema.parse(
      (await accesses({ lat, lon, radiusKm: 100, daylightOnly: true })).json(),
    );
    expect(body.passes.every((p: Pass) => p.daylight)).toBe(true);
    expect(
      body.passes.some((p: Pass) => p.satellite === 'YAM20' && Math.abs(Date.parse(p.tca) - tcaMs) < 5000),
    ).toBe(lit);
  });

  it('finds a pass over the antimeridian with a continuous path', async () => {
    // The exact 10-second arc of the fixture that jumps across ±180° (these happen near the poles).
    const all = segmentsOf(env.geometry);
    const arcs = all.flatMap((s) =>
      s.coords.slice(1).map((b, i) => ({ satellite: s.satellite, a: s.coords[i]!, b })),
    );
    const arc = arcs.find(({ a, b }) => Math.abs(b[0] - a[0]) > 180)!;
    const [lon, lat] = toLonLat(slerp(toVec(arc.a[0], arc.a[1]), toVec(arc.b[0], arc.b[1]), 0.5));
    const body = AccessesResponseSchema.parse(
      (await accesses({ lat, lon, radiusKm: 60, includePath: true })).json(),
    );

    const pass = body.passes.find((p) => p.satellite === arc.satellite);
    expect(pass).toBeDefined();
    const lons = (pass!.path ?? []).map(([l]) => l);
    expect(lons.length).toBeGreaterThan(1);
    // Really crosses ±180°…
    expect(new Set(lons.map((l) => Math.sign(normalizeLon(l))))).toEqual(new Set([-1, 1]));
    // …without a 360° jump in the drawn path (steps are a few degrees even at high latitude).
    for (let i = 1; i < lons.length; i++) expect(Math.abs(lons[i]! - lons[i - 1]!)).toBeLessThan(20);
  });

  it.each([
    [{ lon: 1 }, 'lat'],
    [{ lat: '', lon: 1 }, 'lat'],
    [{ lat: 1, lon: 1, radiusKm: 99_999 }, 'radiusKm'],
    [{ lat: 1, lon: 1, start: '2027-03-02', end: '2027-03-01' }, 'end'],
  ])('rejects %j with field-level issues', async (params, field) => {
    const res = await accesses(params);
    expect(res.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.issues?.map((i) => i.path)).toContain(field);
  });

  it('rejects unknown satellites', async () => {
    const res = await accesses({ lat: 1, lon: 1, satellites: 'YAM20,NOPE' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ message: 'Unknown satellite id(s): NOPE' });
  });

  it('identifies clients behind the configured proxy hops for rate limiting', async () => {
    // Behind Railway/Vercel one proxy hop is trusted: limits apply per real client, not per proxy.
    const proxied = await env.app({ RATE_LIMIT_ACCESSES_PER_MIN: '1', TRUST_PROXY_HOPS: '1' });
    const call = (client: string) =>
      proxied.inject({
        method: 'GET',
        url: `${API}/accesses?lat=1&lon=1`,
        headers: { 'x-forwarded-for': client },
      });
    expect((await call('203.0.113.1')).statusCode).toBe(200);
    expect((await call('203.0.113.2')).statusCode).toBe(200); // a different client is not blocked
    expect((await call('203.0.113.1')).statusCode).toBe(429);
  });

  it('ignores X-Forwarded-For when no proxy is trusted (no limit evasion by spoofing)', async () => {
    const direct = await env.app({ RATE_LIMIT_ACCESSES_PER_MIN: '1' });
    const call = (spoofed: string) =>
      direct.inject({
        method: 'GET',
        url: `${API}/accesses?lat=1&lon=1`,
        headers: { 'x-forwarded-for': spoofed },
      });
    expect((await call('198.51.100.1')).statusCode).toBe(200);
    expect((await call('198.51.100.2')).statusCode).toBe(429);
  });

  it('is rate limited per client', async () => {
    const limited = await env.app({ RATE_LIMIT_ACCESSES_PER_MIN: '2' });
    const call = () => limited.inject({ method: 'GET', url: `${API}/accesses?lat=1&lon=1` });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const blocked = await call();
    expect(blocked.statusCode).toBe(429);
    expect(ApiErrorSchema.parse(blocked.json()).error).toBe('Too Many Requests');
  });
});

describe(`GET ${API}/accesses — options`, () => {
  const onTrack = () => knownSegment.coords[3]!;

  it('omits paths by default and includes them on request', async () => {
    const [lon, lat] = onTrack();
    const plain = AccessesResponseSchema.parse((await accesses({ lat, lon, radiusKm: 100 })).json());
    expect(plain.passes.length).toBeGreaterThan(0);
    expect(plain.passes.every((p) => p.path === undefined)).toBe(true);
    const withPath = AccessesResponseSchema.parse(
      (await accesses({ lat, lon, radiusKm: 100, includePath: true })).json(),
    );
    expect(withPath.passes.every((p) => (p.path?.length ?? 0) >= 2)).toBe(true);
    expect(withPath.query.includePath).toBe(true);
  });

  it('daylightOnly equals the full result filtered by daylight (real data, both kinds present)', async () => {
    // Search the fixture for a place seeing both day and night passes, so the filter really filters.
    const candidates = segmentsOf(env.geometry)
      .filter((_, i) => i % 15 === 0)
      .map((seg) => seg.coords[3]!);
    let full: ReturnType<typeof AccessesResponseSchema.parse> | undefined;
    let target: readonly number[] | undefined;
    for (const [lon, lat] of candidates) {
      const res = AccessesResponseSchema.parse((await accesses({ lat, lon, radiusKm: 2500 })).json());
      if (res.passes.some((p) => p.daylight) && res.passes.some((p) => !p.daylight)) {
        full = res;
        target = [lon, lat];
        break;
      }
    }
    expect(full, 'a target with both day and night passes').toBeDefined();
    const [lon, lat] = target!;
    const day = AccessesResponseSchema.parse(
      (await accesses({ lat: lat!, lon: lon!, radiusKm: 2500, daylightOnly: true })).json(),
    );
    expect(day.passes).toEqual(full!.passes.filter((p) => p.daylight));
    expect(day.passes.length).toBeLessThan(full!.passes.length);
    expect(day.stats.passCount).toBe(day.passes.length);
  });

  it('treats lon=180 and lon=-180 as the same meridian', async () => {
    const east = AccessesResponseSchema.parse((await accesses({ lat: 60, lon: 180, radiusKm: 1500 })).json());
    const west = AccessesResponseSchema.parse(
      (await accesses({ lat: 60, lon: -180, radiusKm: 1500 })).json(),
    );
    expect(east.passes.map((p) => p.id)).toEqual(west.passes.map((p) => p.id));
    expect(east.query.lon).toBe(-180);
  });
});

describe('cross-cutting behaviour', () => {
  it('sends security headers', async () => {
    const res = await get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('allows only configured origins cross-origin', async () => {
    expect(
      (await get(`${API}/dataset`, { origin: 'https://evil.example' })).headers[
        'access-control-allow-origin'
      ],
    ).toBeUndefined();
    const cors = await env.app({ CORS_ORIGINS: 'https://app.example' });
    const res = await cors.inject({
      method: 'GET',
      url: `${API}/dataset`,
      headers: { origin: 'https://app.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example');
    const other = await cors.inject({
      method: 'GET',
      url: `${API}/dataset`,
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('propagates a well-formed upstream request id and replaces a malformed one', async () => {
    expect((await get('/healthz', { 'x-request-id': 'edge-1234abcd' })).headers['x-request-id']).toBe(
      'edge-1234abcd',
    );
    const replaced = (await get('/healthz', { 'x-request-id': 'bad id <script>' })).headers['x-request-id'];
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the error contract for unknown routes', async () => {
    const res = await get('/nope?x=1');
    expect(res.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(res.json())).toMatchObject({ message: 'No route for GET /nope' });
  });

  it('hides internals on server errors', async () => {
    const failing: Database = {
      ...env.db,
      candidateIds: () => Promise.reject(new Error('SELECT secret FROM x')),
    };
    const failingApp = await buildApp({
      config: testConfig(),
      db: failing,
      geometry: env.geometry,
      info: env.info,
      artifacts: env.artifacts,
    });
    const res = await failingApp.inject({ method: 'GET', url: `${API}/accesses?lat=1&lon=1` });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SELECT');
    expect(ApiErrorSchema.parse(res.json()).requestId).toBeTruthy();
    await failingApp.close();
  });

  it('never rate-limits health probes', async () => {
    const tight = await env.app({ RATE_LIMIT_GLOBAL_PER_MIN: '1' });
    for (let i = 0; i < 3; i++)
      expect((await tight.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await tight.inject({ method: 'GET', url: `${API}/dataset` })).statusCode).toBe(200);
    expect((await tight.inject({ method: 'GET', url: `${API}/dataset` })).statusCode).toBe(429);
  });

  it('keys rate limits on the address the trusted proxy saw, not on a client-supplied prefix', async () => {
    const proxied = await env.app({ RATE_LIMIT_ACCESSES_PER_MIN: '1', TRUST_PROXY_HOPS: '1' });
    const call = (xff: string) =>
      proxied.inject({
        method: 'GET',
        url: `${API}/accesses?lat=1&lon=1`,
        headers: { 'x-forwarded-for': xff },
      });
    expect((await call('10.0.0.1, 203.0.113.9')).statusCode).toBe(200);
    expect((await call('10.0.0.2, 203.0.113.9')).statusCode).toBe(429); // rotating the spoofed part is useless
  });

  it.each([
    ['7 characters', 'a'.repeat(7), false],
    ['8 characters', 'a'.repeat(8), true],
    ['64 characters', 'a'.repeat(64), true],
    ['65 characters', 'a'.repeat(65), false],
  ])('accepts an upstream request id of %s only within bounds', async (_label, id, kept) => {
    const res = await get('/healthz', { 'x-request-id': id });
    expect(res.headers['x-request-id'] === id).toBe(kept);
  });

  it('puts the request id on error responses too', async () => {
    const res = await get('/nope');
    expect(res.headers['x-request-id']).toBe(ApiErrorSchema.parse(res.json()).requestId);
  });

  it('serves the OpenAPI document and the docs UI', async () => {
    const spec = (await get('/api/docs/json')).json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(spec.paths).sort((a, b) => a.localeCompare(b))).toEqual([
      `${API}/accesses`,
      `${API}/dataset`,
      `${API}/tracks`,
      `${API}/tracks/binary`,
    ]);
    const ui = await get('/api/docs/');
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
  });

  it('serves identical bodies with the fast production serializer', async () => {
    const prod = await env.app({ NODE_ENV: 'production' });
    const res = await prod.inject({ method: 'GET', url: `${API}/dataset` });
    expect(res.json()).toEqual((await get(`${API}/dataset`)).json());
  });
});
