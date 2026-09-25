/**
 * Pass computation: which portions of the ground tracks fall inside a circle around a target, and
 * when. Pure functions over the typed-array geometry (no I/O), exhaustively unit-tested.
 *
 * For each 10-second arc A→B (unit vectors) and target P, with a = A·P, b = B·P, cos Ω = A·B:
 *  - reject in O(1) without trigonometry when A is farther than r + (max arc length) from P;
 *  - accept the whole arc when both ends are inside (a cap smaller than a hemisphere is convex);
 *  - otherwise intersect analytically (`intersectArcWithCap`) for exact entry/exit fractions.
 * Along the arc P·X(φ) = a·cos φ + β·sin φ, so the closest point is found in closed form too.
 * Pieces from consecutive arcs/segments that touch in time are merged into one pass; the exact
 * (atan2-based) closest distance, the path and the metadata are computed once per pass.
 */
import {
  DAYLIGHT_SUN_ELEVATION_DEG,
  EARTH_RADIUS_KM,
  MS_PER_SECOND,
  centralAngle,
  elevationDeg,
  intersectArcWithCap,
  meanLocalSolarTimeH,
  normalizeLon,
  slerp,
  sunElevationDeg,
  toLonLat,
  toVec,
  type Pass,
  type Vec3,
} from '@ow/shared';

import { isoSeconds as iso, roundToSecond } from '../lib/time.js';

import { MAX_ARC_RAD, vertexVec, type TrackGeometry } from './geometry.js';

export interface PassQuery {
  lon: number;
  lat: number;
  radiusKm: number;
  /** Only the parts of passes inside [startMs, endMs) are reported. */
  startMs: number;
  endMs: number;
  daylightOnly: boolean;
  /** Build each pass's clipped path (off by default: it dominates the response size). */
  includePath: boolean;
}

/** Pieces closer than this in time are the same pass (arc/segment boundaries meet exactly). */
const MERGE_TOLERANCE_MS = 1000;
const DEGENERATE_ARC_SIN = 1e-12;

interface Target {
  p: Vec3;
  cosR: number;
  /** cos(r + max arc): an arc whose start is farther than this cannot reach the circle. */
  cosReach: number;
  startMs: number;
  endMs: number;
}

/** The part of one arc inside the circle and the time window. */
interface Piece {
  /** Index of the arc's first vertex (the arc is vertex → vertex + 1). */
  vertex: number;
  satellite: number;
  arcStartMs: number;
  arcMs: number;
  t0: number;
  t1: number;
  /** Largest P·X on [t0, t1] and where it occurs (fraction of the arc; NaN = not yet located). */
  peakDot: number;
  peakT: number;
  /** P·A, P·B and A·B, to locate the peak later without re-reading the geometry. */
  a: number;
  b: number;
  cosOmega: number;
}

/** P·X(t) along the arc, in closed form: a·cos(tΩ) + β·sin(tΩ). */
interface ArcProfile {
  a: number;
  beta: number;
  omega: number;
}

function arcProfile(a: number, b: number, cosOmega: number): ArcProfile {
  const sinOmega = Math.sqrt(Math.max(0, 1 - cosOmega * cosOmega));
  if (sinOmega < DEGENERATE_ARC_SIN) return { a, beta: 0, omega: 0 };
  return { a, beta: (b - a * cosOmega) / sinOmega, omega: Math.atan2(sinOmega, cosOmega) };
}

const dotAt = (f: ArcProfile, t: number) => f.a * Math.cos(t * f.omega) + f.beta * Math.sin(t * f.omega);

/**
 * Maximum of P·X over the whole arc without trigonometry: an interior peak exists iff the profile
 * rises at the start (β > 0) and falls at the end (−a·sin Ω + β·cos Ω < 0); its value is |(a, β)|.
 * Where it lies (atan2) is only computed later, for the one arc that wins its pass (t = NaN here).
 */
function peakOnFullArc(a: number, b: number, cosOmega: number): { dot: number; t: number } {
  const sinOmega = Math.sqrt(Math.max(0, 1 - cosOmega * cosOmega));
  if (sinOmega >= DEGENERATE_ARC_SIN) {
    const beta = (b - a * cosOmega) / sinOmega;
    if (beta > 0 && -a * sinOmega + beta * cosOmega < 0) return { dot: Math.hypot(a, beta), t: NaN };
  }
  return a >= b ? { dot: a, t: 0 } : { dot: b, t: 1 };
}

/** Maximum of P·X over t ∈ [t0, t1]: at the interior peak (δ = atan2(β, a)) or at an end. */
function peakOn(f: ArcProfile, t0: number, t1: number): { dot: number; t: number } {
  if (f.omega === 0) return { dot: f.a, t: t0 };
  const tPeak = Math.atan2(f.beta, f.a) / f.omega;
  if (tPeak > t0 && tPeak < t1) return { dot: Math.hypot(f.a, f.beta), t: tPeak };
  const d0 = dotAt(f, t0);
  const d1 = dotAt(f, t1);
  return d0 >= d1 ? { dot: d0, t: t0 } : { dot: d1, t: t1 };
}

const dotWith = (g: TrackGeometry, v: number, p: Vec3) =>
  Number(g.x[v]) * p[0] + Number(g.y[v]) * p[1] + Number(g.z[v]) * p[2];

/** Entry/exit fractions of the arc inside the cap, or null. */
function insideFractions(g: TrackGeometry, v: number, a: number, b: number, target: Target) {
  if (a >= target.cosR && b >= target.cosR) return { t0: 0, t1: 1 }; // convex cap: fully inside
  return intersectArcWithCap(vertexVec(g, v), vertexVec(g, v + 1), target.p, target.cosR).inside;
}

function arcPiece(g: TrackGeometry, seg: number, v: number, target: Target): Piece | null {
  const a = dotWith(g, v, target.p);
  if (a < target.cosReach) return null; // too far for this arc to reach the circle

  const first = Number(g.vertexStart[seg]);
  const arcMs =
    (Number(g.endMs[seg]) - Number(g.startMs[seg])) / (Number(g.vertexStart[seg + 1]) - first - 1);
  const arcStartMs = Number(g.startMs[seg]) + (v - first) * arcMs;
  const windowLo = Math.max(0, (target.startMs - arcStartMs) / arcMs);
  const windowHi = Math.min(1, (target.endMs - arcStartMs) / arcMs);
  if (windowLo >= windowHi) return null;

  const b = dotWith(g, v + 1, target.p);
  const inside = insideFractions(g, v, a, b, target);
  if (!inside) return null;
  const t0 = Math.max(inside.t0, windowLo);
  const t1 = Math.min(inside.t1, windowHi);
  if (t0 >= t1) return null;

  const cosOmega =
    Number(g.x[v]) * Number(g.x[v + 1]) +
    Number(g.y[v]) * Number(g.y[v + 1]) +
    Number(g.z[v]) * Number(g.z[v + 1]);
  const peak =
    t0 === 0 && t1 === 1 ? peakOnFullArc(a, b, cosOmega) : peakOn(arcProfile(a, b, cosOmega), t0, t1);
  return {
    vertex: v,
    satellite: Number(g.satelliteIndex[seg]),
    arcStartMs,
    arcMs,
    t0,
    t1,
    peakDot: peak.dot,
    peakT: peak.t,
    a,
    b,
    cosOmega,
  };
}

const pieceStart = (p: Piece) => p.arcStartMs + p.t0 * p.arcMs;
const pieceEnd = (p: Piece) => p.arcStartMs + p.t1 * p.arcMs;

/**
 * A pass under construction: the pieces the summary needs, plus all of them when the path is
 * requested. Without a path they are not kept: a 2,500 km circle at a pole yields ~75,000 pieces,
 * and retaining them was most of that query's garbage-collection time.
 */
interface PassPieces {
  pieces: Piece[];
  first: Piece;
  last: Piece;
  best: Piece;
}

/** Extends the latest pass when the piece continues it (same satellite, touching in time). */
function addPiece(passes: PassPieces[], piece: Piece, keepPieces: boolean): void {
  const current = passes.at(-1);
  const continues =
    current?.last.satellite === piece.satellite &&
    pieceStart(piece) - pieceEnd(current.last) <= MERGE_TOLERANCE_MS;
  if (!current || !continues) {
    passes.push({ pieces: keepPieces ? [piece] : [], first: piece, last: piece, best: piece });
    return;
  }
  if (keepPieces) current.pieces.push(piece);
  current.last = piece;
  if (piece.peakDot > current.best.peakDot) current.best = piece;
}

/** Groups pieces (in satellite-then-time order) into passes. */
function groupPasses(
  g: TrackGeometry,
  segmentIds: Iterable<number>,
  target: Target,
  keepPieces: boolean,
): PassPieces[] {
  const passes: PassPieces[] = [];
  for (const seg of segmentIds) {
    if (Number(g.endMs[seg]) <= target.startMs || Number(g.startMs[seg]) >= target.endMs) continue;
    const lastVertex = Number(g.vertexStart[seg + 1]) - 1;
    for (let v = Number(g.vertexStart[seg]); v < lastVertex; v++) {
      const piece = arcPiece(g, seg, v, target);
      if (piece) addPiece(passes, piece, keepPieces);
    }
  }
  return passes;
}

const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

/** Point at fraction t of the arc starting at vertex v. */
const pointOn = (g: TrackGeometry, v: number, t: number): Vec3 => {
  if (t <= 0) return vertexVec(g, v);
  if (t >= 1) return vertexVec(g, v + 1);
  return slerp(vertexVec(g, v), vertexVec(g, v + 1), t);
};

/** [lon, lat] at fraction t of the arc from vertex v: array reads at vertices, slerp only between. */
function lonLatOn(g: TrackGeometry, v: number, t: number): readonly [number, number] {
  if (t <= 0) return [Number(g.lon[v]), Number(g.lat[v])];
  if (t >= 1) return [Number(g.lon[v + 1]), Number(g.lat[v + 1])];
  return toLonLat(slerp(vertexVec(g, v), vertexVec(g, v + 1), t));
}

/** Entry point, every vertex inside, exit point; continuous longitudes, rounded to ~1 m. */
function passPath(g: TrackGeometry, pieces: readonly Piece[]): [number, number][] {
  const first = pieces[0];
  const points = first ? [lonLatOn(g, first.vertex, first.t0)] : [];
  for (const p of pieces) points.push(lonLatOn(g, p.vertex, p.t1));
  const out: [number, number][] = [];
  let prevLon = 0;
  for (const [lon, lat] of points) {
    const continuous = out.length === 0 ? lon : prevLon + normalizeLon(lon - prevLon);
    out.push([round(continuous, 5), round(lat, 5)]);
    prevLon = continuous;
  }
  return out;
}

const satelliteName = (g: TrackGeometry, p: PassPieces) => g.satellites[p.first.satellite] ?? '';

/** The cheap facts needed to filter and order passes before building full Pass objects. */
interface PassSummary extends PassPieces {
  peakT: number;
  tcaMs: number;
  startMs: number;
  sunElevation: number;
}

function summarise(pass: PassPieces, q: PassQuery): PassSummary {
  const { best } = pass;
  // Locate the interior peak (atan2) only for the winning arc of the pass.
  const peakT = Number.isNaN(best.peakT)
    ? peakOn(arcProfile(best.a, best.b, best.cosOmega), best.t0, best.t1).t
    : best.peakT;
  const tcaMs = best.arcStartMs + peakT * best.arcMs;
  return {
    ...pass,
    peakT,
    tcaMs,
    startMs: roundToSecond(pieceStart(pass.first)),
    sunElevation: sunElevationDeg(tcaMs, q.lon, q.lat),
  };
}

function toPass(g: TrackGeometry, p: PassSummary, q: PassQuery, target: Target): Pass {
  const { best, last, peakT, tcaMs, startMs, sunElevation } = p;
  // Exact distance once per pass (acos of a dot near 1 would lose ~10 cm on overhead passes).
  const closestAngle = centralAngle(pointOn(g, best.vertex, peakT), target.p);
  const altA = Number(g.altKm[best.vertex]);
  const altKm = altA + (Number(g.altKm[best.vertex + 1]) - altA) * peakT;
  const satellite = satelliteName(g, p);
  return {
    id: `${satellite}-${startMs / MS_PER_SECOND}`,
    satellite,
    start: iso(startMs),
    end: iso(pieceEnd(last)),
    durationS: (roundToSecond(pieceEnd(last)) - startMs) / MS_PER_SECOND,
    tca: iso(tcaMs),
    minDistanceKm: round(closestAngle * EARTH_RADIUS_KM, 1),
    maxElevationDeg: round(elevationDeg(closestAngle, altKm), 1),
    sunElevationDeg: round(sunElevation, 1),
    daylight: sunElevation > DAYLIGHT_SUN_ELEVATION_DEG,
    // z = sin(latitude): moving to larger z means moving north.
    direction: Number(g.z[best.vertex + 1]) > Number(g.z[best.vertex]) ? 'ascending' : 'descending',
    localSolarTimeH: round(meanLocalSolarTimeH(tcaMs, q.lon), 3) % 24,
    altitudeKm: round(altKm, 1),
    ...(q.includePath ? { path: passPath(g, p.pieces) } : {}),
  };
}

/**
 * @param segmentIds segments to consider, ordered by satellite then time (candidate ids from
 *   DuckDB, or every segment)
 * @returns passes sorted by start time (then satellite)
 */
export function computePasses(g: TrackGeometry, segmentIds: Iterable<number>, q: PassQuery): Pass[] {
  const rAngle = q.radiusKm / EARTH_RADIUS_KM;
  const target: Target = {
    p: toVec(q.lon, q.lat),
    cosR: Math.cos(rAngle),
    cosReach: rAngle + MAX_ARC_RAD >= Math.PI ? -1 : Math.cos(rAngle + MAX_ARC_RAD),
    startMs: q.startMs,
    endMs: q.endMs,
  };
  // Filter and sort on cheap numbers first; full Pass objects are only built for what is returned.
  return (
    groupPasses(g, segmentIds, target, q.includePath)
      .map((pass) => summarise(pass, q))
      .filter((p) => !q.daylightOnly || p.sunElevation > DAYLIGHT_SUN_ELEVATION_DEG)
      // Ties (simultaneous passes) are rare: order them by satellite name.
      .sort((a, b) => a.startMs - b.startMs || satelliteName(g, a).localeCompare(satelliteName(g, b)))
      .map((p) => toPass(g, p, q, target))
  );
}
