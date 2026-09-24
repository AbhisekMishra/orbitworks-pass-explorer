/**
 * Compact binary encoding of satellite ground tracks ("OWT1").
 *
 * Why a custom format: the full week is 59 MB of GeoJSON; the map needs it in one go so filters can
 * run on the GPU. Tracks are smooth curves sampled at a fixed step, so:
 *  - timestamps are implicit (vertex i is at startS + i·stepS) and never transmitted;
 *  - coordinates are quantized (lon/lat to 1e-4°, ≈ 11 m; altitude to 100 m by default) and stored
 *    as second-order differences, which are tiny integers on a smooth orbit;
 *  - integers are zig-zag + LEB128 varint encoded.
 * Measured on the real dataset (604,870 vertices): 2.1 MB raw, 0.52 MB brotli (quality 11 — lower
 * qualities exceed the 600 KB budget, so the API must precompress), 0.90 MB gzip, vs 59 MB GeoJSON.
 * Encode ≈ 65 ms (once, at API boot), decode ≈ 16 ms (one linear pass + a longitude wrap pass).
 *
 * Layout (little-endian):
 *   [0..3]   magic "OWT1"
 *   [4..7]   uint32 header length H
 *   [8..8+H) UTF-8 JSON header (TrackHeader)
 *   [...]    varint body: for each track in header order → lon Δ² × n, lat Δ² × n, alt Δ² × n
 *
 * Longitudes are unwrapped (made continuous across the antimeridian) before differencing so the
 * differences stay small, and wrapped back to [-180, 180) on decode: unwrapped values drift to
 * ~-41,000° over a week, which would cost ~200 m of precision once cast to Float32 for the GPU.
 *
 * The decoder is written for untrusted input: every size is checked before it is allocated, and
 * failures are always a TrackCodecError. It deliberately does not depend on zod, so the browser's
 * decode worker stays ~1 KB instead of ~25 KB gzip.
 */
import { SATELLITE_ID_PATTERN } from './constants.js';
import { normalizeLon } from './geo.js';

const MAGIC = 'OWT1';
const PREAMBLE_BYTES = 8;
const MAX_HEADER_BYTES = 1 << 20;
const MAX_TRACKS = 1024;
/** Every vertex writes three varints of at least one byte each. */
const MIN_BODY_BYTES_PER_VERTEX = 3;
/** Quantized magnitudes are kept far below 2^53 so second differences (≤ 4×) stay exact. */
const MAX_ABS_QUANTIZED = 2 ** 50;
/** Longest varint accepted: 8 bytes carry 56 bits, enough for any safe integer. */
const MAX_VARINT_SCALE = 2 ** 49;

export const TRACK_CODEC_VERSION = 1;
export const TRACK_CODEC_MEDIA_TYPE = 'application/vnd.orbitworks.tracks+octet-stream';
export const DEFAULT_QUANTUM_DEG = 1e-4;
/** 100 m: altitude is only displayed (to 0.1 km); exact elevations are computed server-side. */
export const DEFAULT_ALT_QUANTUM_KM = 0.1;

export interface TrackHeaderEntry {
  satellite: string;
  /** Epoch seconds (UTC) of the first vertex. */
  startS: number;
  vertexCount: number;
}

export interface TrackHeader {
  version: typeof TRACK_CODEC_VERSION;
  stepS: number;
  quantumDeg: number;
  altQuantumKm: number;
  tracks: TrackHeaderEntry[];
}

export interface TrackInput {
  satellite: string;
  /** Epoch seconds (UTC) of the first vertex. */
  startS: number;
  lon: ArrayLike<number>;
  lat: ArrayLike<number>;
  altKm: ArrayLike<number>;
}

export interface DecodedTrack {
  satellite: string;
  startS: number;
  /** Longitudes in degrees, normalized to [-180, 180). */
  lon: Float64Array;
  lat: Float64Array;
  altKm: Float64Array;
}

export interface DecodedTracks {
  header: TrackHeader;
  tracks: DecodedTrack[];
}

export class TrackCodecError extends Error {
  override name = 'TrackCodecError';
}

const fail = (message: string): never => {
  throw new TrackCodecError(message);
};

// ---------------------------------------------------------------------------------------------
// Header validation (hand-written on purpose: see the module comment about bundle size).

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function positiveNumber(v: unknown, field: string): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? v
    : fail(`${field} must be a positive number`);
}

function trackEntry(v: unknown, index: number): TrackHeaderEntry {
  if (!isRecord(v)) return fail(`tracks[${index}] must be an object`);
  const { satellite, startS, vertexCount } = v;
  if (typeof satellite !== 'string' || !SATELLITE_ID_PATTERN.test(satellite)) {
    return fail(`tracks[${index}].satellite is not a valid satellite id`);
  }
  if (typeof startS !== 'number' || !Number.isSafeInteger(startS)) {
    return fail(`tracks[${index}].startS must be an integer`);
  }
  if (typeof vertexCount !== 'number' || !Number.isSafeInteger(vertexCount) || vertexCount < 0) {
    return fail(`tracks[${index}].vertexCount must be a non-negative integer`);
  }
  return { satellite, startS, vertexCount };
}

export function validateTrackHeader(json: unknown): TrackHeader {
  if (!isRecord(json)) return fail('Unsupported header: not an object');
  if (json.version !== TRACK_CODEC_VERSION)
    return fail(`Unsupported header: version ${String(json.version)}`);
  if (!Array.isArray(json.tracks) || json.tracks.length > MAX_TRACKS) {
    return fail(`Unsupported header: tracks must be an array of at most ${MAX_TRACKS}`);
  }
  return {
    version: TRACK_CODEC_VERSION,
    stepS: positiveNumber(json.stepS, 'stepS'),
    quantumDeg: positiveNumber(json.quantumDeg, 'quantumDeg'),
    altQuantumKm: positiveNumber(json.altQuantumKm, 'altQuantumKm'),
    tracks: (json.tracks as unknown[]).map(trackEntry),
  };
}

// ---------------------------------------------------------------------------------------------
// Varint primitives. Arithmetic (not bitwise) zig-zag keeps values beyond ±2^31 exact.

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  uint32(value: number): void {
    this.ensure(4);
    new DataView(this.buf.buffer).setUint32(this.len, value, true);
    this.len += 4;
  }

  /** Signed (safe) integer as zig-zag varint. */
  svarint(value: number): void {
    let u = value >= 0 ? value * 2 : -value * 2 - 1;
    this.ensure(10);
    while (u >= 0x80) {
      this.buf[this.len++] = (u % 0x80) | 0x80;
      u = Math.floor(u / 0x80);
    }
    this.buf[this.len++] = u;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  svarint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      if (this.pos >= this.buf.length) throw new TrackCodecError('Truncated body');
      const byte = Number(this.buf[this.pos++]); // in bounds: checked above
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
      if (scale > MAX_VARINT_SCALE) throw new TrackCodecError('Varint too long');
    }
    if (result > Number.MAX_SAFE_INTEGER) throw new TrackCodecError('Varint exceeds the safe integer range');
    return result % 2 === 0 ? result / 2 : -(result + 1) / 2;
  }
}

// ---------------------------------------------------------------------------------------------
// Streams

type StreamKind = 'lon' | 'lat' | 'alt';
const VALUE_LIMIT: Record<StreamKind, number> = { lon: 360, lat: 90, alt: Infinity };

function quantize(values: ArrayLike<number>, quantum: number, kind: StreamKind): number[] {
  const out = new Array<number>(values.length);
  const limit = VALUE_LIMIT[kind];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const raw = Number(values[i]);
    if (!Number.isFinite(raw) || Math.abs(raw) > limit) fail(`Invalid ${kind} value at index ${i}`);
    // Unwrap in constant time: take the shortest step from the previous (unwrapped) longitude.
    const v = kind === 'lon' && i > 0 ? prev + normalizeLon(raw - prev) : raw;
    const q = Math.round(v / quantum);
    if (Math.abs(q) > MAX_ABS_QUANTIZED) fail(`${kind} value at index ${i} is out of range for the quantum`);
    out[i] = q;
    prev = v;
  }
  return out;
}

/**
 * Second differences qᵢ − 2qᵢ₋₁ + qᵢ₋₂, with virtual zeros before the first sample. The uniform
 * formula keeps encoder and decoder branch-free; it only costs a few bytes on each track's first two
 * samples.
 */
function writeSecondDifferences(w: ByteWriter, q: Iterable<number>): void {
  let prev = 0;
  let prevDelta = 0;
  for (const value of q) {
    const delta = value - prev;
    w.svarint(delta - prevDelta);
    prev = value;
    prevDelta = delta;
  }
}

function readSecondDifferences(r: ByteReader, n: number, quantum: number): Float64Array {
  const out = new Float64Array(n);
  let value = 0;
  let delta = 0;
  for (let i = 0; i < n; i++) {
    delta += r.svarint();
    value += delta;
    out[i] = value * quantum;
  }
  return out;
}

/**
 * Same result as normalizeLon ([-180, 180)) with one division instead of two modulos, in a plain
 * loop: this pass runs over every decoded vertex, and the naive version doubled decode time.
 */
function wrapLongitudesInPlace(lon: Float64Array): void {
  for (let i = 0; i < lon.length; i++) {
    const l = Number(lon[i]); // index is in bounds
    lon[i] = l - 360 * Math.floor((l + 180) / 360);
  }
}

// ---------------------------------------------------------------------------------------------
// Public API

export interface EncodeOptions {
  stepS: number;
  quantumDeg?: number;
  altQuantumKm?: number;
}

export function encodeTracks(
  tracks: readonly TrackInput[],
  { stepS, quantumDeg = DEFAULT_QUANTUM_DEG, altQuantumKm = DEFAULT_ALT_QUANTUM_KM }: EncodeOptions,
): Uint8Array {
  for (const t of tracks) {
    if (t.lon.length !== t.lat.length || t.lon.length !== t.altKm.length) {
      fail(`Track ${t.satellite}: lon/lat/alt lengths differ`);
    }
  }
  const header = validateTrackHeader({
    version: TRACK_CODEC_VERSION,
    stepS,
    quantumDeg,
    altQuantumKm,
    tracks: tracks.map((t) => ({ satellite: t.satellite, startS: t.startS, vertexCount: t.lon.length })),
  });

  // ≤ 1024 tracks with ≤ 32-char ids keep the header far below MAX_HEADER_BYTES.
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const w = new ByteWriter();
  w.bytes(new TextEncoder().encode(MAGIC));
  w.uint32(headerBytes.length);
  w.bytes(headerBytes);
  for (const t of tracks) {
    writeSecondDifferences(w, quantize(t.lon, quantumDeg, 'lon'));
    writeSecondDifferences(w, quantize(t.lat, quantumDeg, 'lat'));
    writeSecondDifferences(w, quantize(t.altKm, altQuantumKm, 'alt'));
  }
  return w.finish();
}

function readHeader(bytes: Uint8Array): { header: TrackHeader; bodyStart: number } {
  if (bytes.length < PREAMBLE_BYTES || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    return fail('Not an OWT1 track stream (bad magic)');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (headerLength > MAX_HEADER_BYTES || PREAMBLE_BYTES + headerLength > bytes.length) {
    return fail('Invalid header length');
  }
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerLength)),
    );
  } catch {
    return fail('Header is not valid JSON');
  }
  const header = validateTrackHeader(json);
  const bodyStart = PREAMBLE_BYTES + headerLength;
  // Refuse to allocate for vertices the body cannot possibly contain (forged/corrupt header).
  const declaredVertices = header.tracks.reduce((sum, t) => sum + t.vertexCount, 0);
  if (declaredVertices * MIN_BODY_BYTES_PER_VERTEX > bytes.length - bodyStart) {
    return fail('Header declares more vertices than the body can hold');
  }
  return { header, bodyStart };
}

export function decodeTracks(input: ArrayBuffer | Uint8Array): DecodedTracks {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { header, bodyStart } = readHeader(bytes);
  const r = new ByteReader(bytes, bodyStart);
  const tracks = header.tracks.map((t) => {
    const lon = readSecondDifferences(r, t.vertexCount, header.quantumDeg);
    wrapLongitudesInPlace(lon);
    return {
      satellite: t.satellite,
      startS: t.startS,
      lon,
      lat: readSecondDifferences(r, t.vertexCount, header.quantumDeg),
      altKm: readSecondDifferences(r, t.vertexCount, header.altQuantumKm),
    };
  });
  if (r.pos !== bytes.length) fail('Trailing bytes after body');
  return { header, tracks };
}
