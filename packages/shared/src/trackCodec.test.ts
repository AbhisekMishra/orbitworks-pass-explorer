import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { destination, normalizeLon } from './geo.js';
import {
  DEFAULT_ALT_QUANTUM_KM,
  DEFAULT_QUANTUM_DEG,
  TRACK_CODEC_VERSION,
  TrackCodecError,
  decodeTracks,
  encodeTracks,
  type TrackInput,
} from './trackCodec.js';

const STEP_S = 10;
/** Ground distance covered in one 10 s step by a ~500 km LEO (≈ 7.6 km/s ground speed). */
const STEP_KM = 76;

/** A smooth great-circle "orbit" like the real tracks, crossing the antimeridian when it goes east. */
function syntheticTrack(
  satellite: string,
  lon0: number,
  lat0: number,
  bearing: number,
  n: number,
): TrackInput {
  const lon: number[] = [];
  const lat: number[] = [];
  const altKm: number[] = [];
  let p: [number, number] = [lon0, lat0];
  for (let i = 0; i < n; i++) {
    lon.push(p[0]);
    lat.push(p[1]);
    altKm.push(500 + 20 * Math.sin(i / 50));
    p = destination(p[0], p[1], bearing, STEP_KM);
  }
  return { satellite, startS: 1_803_859_200 + i0(satellite), lon, lat, altKm };
}
const i0 = (s: string) => s.length * 60;

function expectRoundTrip(input: TrackInput, decoded: ReturnType<typeof decodeTracks>['tracks'][number]) {
  expect(decoded.satellite).toBe(input.satellite);
  expect(decoded.startS).toBe(input.startS);
  expect(decoded.lon).toHaveLength(input.lon.length);
  for (let i = 0; i < input.lon.length; i++) {
    const dLon = Math.abs(normalizeLon((decoded.lon[i] ?? 0) - (input.lon[i] ?? 0)));
    expect(dLon).toBeLessThanOrEqual(DEFAULT_QUANTUM_DEG / 2 + 1e-9);
    expect(Math.abs((decoded.lat[i] ?? 0) - (input.lat[i] ?? 0))).toBeLessThanOrEqual(
      DEFAULT_QUANTUM_DEG / 2 + 1e-9,
    );
    expect(Math.abs((decoded.altKm[i] ?? 0) - (input.altKm[i] ?? 0))).toBeLessThanOrEqual(
      DEFAULT_ALT_QUANTUM_KM / 2 + 1e-9,
    );
  }
}

describe('encodeTracks / decodeTracks', () => {
  it('round-trips several tracks within half a quantum and keeps header metadata', () => {
    const tracks = [syntheticTrack('YAM20', 10, 5, 20, 500), syntheticTrack('YAM21', -60, -40, 160, 300)];
    const { header, tracks: out } = decodeTracks(encodeTracks(tracks, { stepS: STEP_S }));
    expect(header).toMatchObject({
      version: TRACK_CODEC_VERSION,
      stepS: STEP_S,
      quantumDeg: DEFAULT_QUANTUM_DEG,
    });
    expect(header.tracks.map((t) => t.vertexCount)).toEqual([500, 300]);
    tracks.forEach((t, i) => {
      expectRoundTrip(t, out[i]!);
    });
  });

  it.each([
    ['eastward', 179.5, 90],
    ['westward', -179.5, 270],
  ])('crosses the antimeridian %s and decodes to normalized longitudes', (_dir, lon0, bearing) => {
    const track = syntheticTrack('A', lon0, 0, bearing, 5);
    const lons = Array.from(track.lon);
    expect(lons.some((l) => l > 0) && lons.some((l) => l < 0)).toBe(true); // really crosses ±180
    const [decoded] = decodeTracks(encodeTracks([track], { stepS: STEP_S })).tracks;
    for (const l of decoded!.lon) {
      expect(l).toBeGreaterThanOrEqual(-180);
      expect(l).toBeLessThan(180);
    }
    expectRoundTrip(track, decoded!);
  });

  it('stays in normalized range after many unwrapped revolutions (Float32-safe output)', () => {
    // A track circling eastward ~14 times: unwrapped longitudes would reach ~5000°.
    const track = syntheticTrack('LOOP', 0, 0, 90, 7400);
    const [decoded] = decodeTracks(encodeTracks([track], { stepS: STEP_S })).tracks;
    const worstFloat32ErrorDeg = Math.max(
      ...Array.from(decoded!.lon, (l, i) => Math.abs(normalizeLon(Math.fround(l) - (track.lon[i] ?? 0)))),
    );
    expect(worstFloat32ErrorDeg).toBeLessThan(DEFAULT_QUANTUM_DEG); // < 11 m after the GPU cast
  });

  it('survives a pole crossing', () => {
    const track = syntheticTrack('POLE', 10, 89, 0, 10); // due north over the pole
    expect(Array.from(track.lat).some((l, i) => i > 0 && l < (track.lat[i - 1] ?? 0))).toBe(true);
    expectRoundTrip(track, decodeTracks(encodeTracks([track], { stepS: STEP_S })).tracks[0]!);
  });

  it('is exact for integers beyond the 32-bit range (arithmetic zig-zag, not bitwise)', () => {
    // 3,000,000 km at an explicit 1 m quantum = 3e9 quanta > 2^31: bitwise zig-zag would overflow.
    const huge = 3_000_000;
    const track: TrackInput = {
      satellite: 'BIG',
      startS: 0,
      lon: [0, 170, 340],
      lat: [0, 0, 0],
      altKm: [huge, huge, -huge],
    };
    const [out] = decodeTracks(encodeTracks([track], { stepS: 1, altQuantumKm: 0.001 })).tracks;
    expect(Array.from(out!.altKm)).toEqual([huge, huge, -huge]);
    expect(Array.from(out!.lon)).toEqual([0, 170, -20]); // 340° is decoded normalized
  });

  it('handles empty inputs and tiny tracks', () => {
    expect(decodeTracks(encodeTracks([], { stepS: STEP_S })).tracks).toEqual([]);
    for (const n of [0, 1, 2, 3]) {
      const t = syntheticTrack(`N${n}`, 1, 1, 45, n);
      const [out] = decodeTracks(encodeTracks([t], { stepS: STEP_S })).tracks;
      expectRoundTrip(t, out!);
    }
  });

  it('decodes from an ArrayBuffer and from a Uint8Array view with an offset', () => {
    const bytes = encodeTracks([syntheticTrack('V', 0, 0, 0, 10)], { stepS: STEP_S });
    expect(decodeTracks(bytes.slice().buffer).tracks).toHaveLength(1);
    const padded = new Uint8Array(bytes.length + 16);
    padded.set(bytes, 16);
    expect(decodeTracks(padded.subarray(16)).tracks[0]?.satellite).toBe('V');
  });

  it('is at least 3× smaller than float32 lon/lat/alt before HTTP compression', () => {
    const tracks = Array.from({ length: 4 }, (_, k) =>
      syntheticTrack(`S${k}`, k * 40, -30, 10 + k * 5, 5000),
    );
    const bytes = encodeTracks(tracks, { stepS: STEP_S });
    const FLOAT32_BYTES_PER_VERTEX = 12; // lon, lat, alt
    expect(bytes.length / (4 * 5000)).toBeLessThan(FLOAT32_BYTES_PER_VERTEX / 3);
  });

  it('grows its buffer for large bodies and for a header larger than twice the initial buffer', () => {
    const long = syntheticTrack('LONG', 5, 5, 30, 30_000); // ≥ 3 bytes/vertex → ~90 KB body
    const bytes = encodeTracks([long], { stepS: STEP_S });
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    expectRoundTrip(long, decodeTracks(bytes).tracks[0]!);
  });

  it('accepts up to 1024 tracks with maximum-length ids', () => {
    const many = Array.from({ length: 1024 }, (_, k) =>
      syntheticTrack(`S${String(k).padStart(31, '0')}`, 0, 0, 0, 0),
    );
    const decoded = decodeTracks(encodeTracks(many, { stepS: STEP_S }));
    expect(decoded.tracks).toHaveLength(1024);
    expect(decoded.tracks[1023]?.satellite).toBe(many[1023]?.satellite);
  });

  it('round-trips arbitrary smooth tracks (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -180, max: 179.99, noNaN: true }),
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.integer({ min: 0, max: 400 }),
        (lon, lat, bearing, n) => {
          const t = syntheticTrack('P', lon, lat, bearing, n);
          expectRoundTrip(t, decodeTracks(encodeTracks([t], { stepS: STEP_S })).tracks[0]!);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('encoder validation', () => {
  it('rejects mismatched array lengths', () => {
    const t: TrackInput = { satellite: 'X', startS: 0, lon: [1, 2], lat: [1], altKm: [1, 2] };
    expect(() => encodeTracks([t], { stepS: STEP_S })).toThrow(TrackCodecError);
  });

  const point = (overrides: Partial<TrackInput>): TrackInput => ({
    satellite: 'X',
    startS: 0,
    lon: [1, 2],
    lat: [1, 1],
    altKm: [500, 500],
    ...overrides,
  });

  it.each([
    ['NaN longitude', { lon: [1, NaN] }, /Invalid lon/],
    ['huge finite longitude (would never unwrap in a loop)', { lon: [0, 1e20] }, /Invalid lon/],
    ['latitude beyond the pole', { lat: [1, 91] }, /Invalid lat/],
    ['infinite altitude', { altKm: [500, Infinity] }, /Invalid alt/],
    ['altitude too large for the quantum', { altKm: [500, 1e15] }, /out of range/],
    ['empty satellite id', { satellite: '' }, /satellite id/],
    ['markup in the satellite id', { satellite: '<img src=x>' }, /satellite id/],
    ['fractional start time', { startS: 1.5 }, /startS/],
  ])('rejects %s with a TrackCodecError', (_label, overrides, message) => {
    const run = () => encodeTracks([point(overrides)], { stepS: STEP_S });
    expect(run).toThrow(TrackCodecError);
    expect(run).toThrow(message);
  });

  it.each([
    ['stepS', { stepS: 0 }, /stepS must be a positive number/],
    ['quantumDeg', { stepS: STEP_S, quantumDeg: -1 }, /quantumDeg must be a positive number/],
    ['altQuantumKm', { stepS: STEP_S, altQuantumKm: NaN }, /altQuantumKm must be a positive number/],
  ])('rejects a non-positive %s', (_field, options, message) => {
    expect(() => encodeTracks([point({})], options)).toThrow(message);
  });

  it('rejects more than 1024 tracks', () => {
    const many = Array.from({ length: 1025 }, (_, k) => point({ satellite: `S${k}` }));
    expect(() => encodeTracks(many, { stepS: STEP_S })).toThrow(/at most 1024/);
  });
});

describe('decoder hardening', () => {
  const valid = () => encodeTracks([syntheticTrack('H', 0, 0, 0, 20)], { stepS: STEP_S });
  const withHeader = (json: string, body: number[] = []) => {
    const h = new TextEncoder().encode(json);
    const out = new Uint8Array(8 + h.length + body.length);
    out.set(new TextEncoder().encode('OWT1'));
    new DataView(out.buffer).setUint32(4, h.length, true);
    out.set(h, 8);
    out.set(body, 8 + h.length);
    return out;
  };

  it.each([
    ['empty input', new Uint8Array()],
    ['bad magic', new TextEncoder().encode('NOPE0000')],
  ])('rejects %s', (_label, bytes) => {
    expect(() => decodeTracks(bytes)).toThrow(/bad magic/);
  });

  it.each([
    ['above the 1 MB cap', 0xffffff],
    ['below the cap but past the end of the buffer', 1000],
  ])('rejects a header length %s', (_label, length) => {
    const bytes = valid();
    new DataView(bytes.buffer).setUint32(4, length, true);
    expect(() => decodeTracks(bytes)).toThrow(/header length/);
  });

  it.each([
    ['a non-object header', '[]', /not an object/],
    [
      'a non-array tracks field',
      '{"version":1,"stepS":10,"quantumDeg":1,"altQuantumKm":1,"tracks":{}}',
      /tracks/,
    ],
    [
      'a non-object track entry',
      '{"version":1,"stepS":10,"quantumDeg":1,"altQuantumKm":1,"tracks":[7]}',
      /must be an object/,
    ],
    [
      'a negative vertexCount',
      '{"version":1,"stepS":10,"quantumDeg":1,"altQuantumKm":1,"tracks":[{"satellite":"A","startS":0,"vertexCount":-1}]}',
      /vertexCount/,
    ],
  ])('rejects %s', (_label, json, message) => {
    expect(() => decodeTracks(withHeader(json))).toThrow(message);
  });

  it('refuses to allocate for vertices the body cannot hold (forged vertexCount)', () => {
    const header = {
      version: 1,
      stepS: 10,
      quantumDeg: 1e-4,
      altQuantumKm: 1e-3,
      tracks: [{ satellite: 'A', startS: 0, vertexCount: 1e12 }],
    };
    const run = () => decodeTracks(withHeader(JSON.stringify(header)));
    expect(run).toThrow(TrackCodecError); // not a RangeError from a 8 TB Float64Array
    expect(run).toThrow(/more vertices than the body/);
  });

  it('rejects varints beyond the safe integer range', () => {
    const header = {
      version: 1,
      stepS: 10,
      quantumDeg: 1e-4,
      altQuantumKm: 1e-3,
      tracks: [{ satellite: 'A', startS: 0, vertexCount: 1 }],
    };
    const eightByteVarint = [...new Array<number>(7).fill(0xff), 0x7f]; // 2^56 − 1
    expect(() => decodeTracks(withHeader(JSON.stringify(header), eightByteVarint))).toThrow(/safe integer/);
  });

  it('rejects a header that is not JSON', () => {
    expect(() => decodeTracks(withHeader('{not json'))).toThrow(/not valid JSON/);
  });

  it('rejects an unsupported version', () => {
    const header = { version: 99, stepS: 10, quantumDeg: 1e-4, altQuantumKm: 1e-3, tracks: [] };
    expect(() => decodeTracks(withHeader(JSON.stringify(header)))).toThrow(/Unsupported header/);
  });

  it('rejects a truncated body', () => {
    const bytes = valid();
    expect(() => decodeTracks(bytes.subarray(0, bytes.length - 3))).toThrow(/Truncated/);
  });

  it('rejects trailing bytes', () => {
    const bytes = valid();
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => decodeTracks(longer)).toThrow(/Trailing/);
  });

  it('rejects over-long varints', () => {
    const header = {
      version: 1,
      stepS: 10,
      quantumDeg: 1e-4,
      altQuantumKm: 1e-3,
      tracks: [{ satellite: 'A', startS: 0, vertexCount: 1 }],
    };
    expect(() => decodeTracks(withHeader(JSON.stringify(header), new Array<number>(12).fill(0xff)))).toThrow(
      /too long/,
    );
  });
});
