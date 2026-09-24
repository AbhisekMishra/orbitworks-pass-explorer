/**
 * Spherical geometry used by the access computation (API) and by map overlays (web).
 *
 * Everything works on unit vectors on a spherical Earth. At LEO access scales the difference with
 * the WGS84 ellipsoid is < 0.5 % of the distance, which is far below the 10-second sampling
 * resolution of the input tracks, so the extra complexity of geodesics on the ellipsoid isn't worth it.
 */
import { EARTH_RADIUS_KM } from './constants.js';

export type Vec3 = readonly [number, number, number];
export type LonLat = readonly [lon: number, lat: number];
/** [minLon, minLat, maxLon, maxLat] */
export type BBox = readonly [number, number, number, number];

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const toRad = (deg: number): number => deg * DEG;
export const toDeg = (rad: number): number => rad * RAD;

export function toVec(lon: number, lat: number): Vec3 {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

export function toLonLat(v: Vec3): [number, number] {
  const [x, y, z] = v;
  return [Math.atan2(y, x) * RAD, Math.atan2(z, Math.hypot(x, y)) * RAD];
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Central angle between two unit vectors (radians). atan2 form is stable for tiny and near-antipodal angles. */
export function centralAngle(a: Vec3, b: Vec3): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), dot(a, b));
}

export function distanceKm(a: LonLat, b: LonLat): number {
  return centralAngle(toVec(a[0], a[1]), toVec(b[0], b[1])) * EARTH_RADIUS_KM;
}

/**
 * Wrap a longitude into [-180, 180). Values already in range are returned as they are: the
 * modular arithmetic would otherwise add float noise (54.377 → 54.37699999999995) to user input.
 */
export function normalizeLon(lon: number): number {
  if (lon >= -180 && lon < 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Wrap an hour value into [0, 24). The source `local_time_h` is unwrapped (it ranges ~-12..36). */
export function normalizeHours(h: number): number {
  return ((h % 24) + 24) % 24;
}

/**
 * Elevation of a satellite above the local horizon, seen from a ground point.
 * @param centralAngleRad great-circle angle between the ground point and the sub-satellite point
 */
export function elevationDeg(centralAngleRad: number, altitudeKm: number): number {
  const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm);
  return Math.atan2(Math.cos(centralAngleRad) - ratio, Math.sin(centralAngleRad)) * RAD;
}

/** Inverse of {@link elevationDeg}: ground range (km) at which a satellite is seen at `elevation`. */
export function groundRangeKmForElevation(elevation: number, altitudeKm: number): number {
  const e = elevation * DEG;
  const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm);
  return (Math.acos(ratio * Math.cos(e)) - e) * EARTH_RADIUS_KM;
}

/** Point reached travelling `distanceKm` from (lon, lat) on initial `bearingDeg` (clockwise from north). */
export function destination(lon: number, lat: number, bearingDeg: number, distKm: number): [number, number] {
  const d = distKm / EARTH_RADIUS_KM;
  const b = bearingDeg * DEG;
  const la1 = lat * DEG;
  const lo1 = lon * DEG;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [normalizeLon(lo2 * RAD), la2 * RAD];
}

/** Closed polygon ring approximating the geodesic circle (spherical cap boundary). */
export function geodesicCircle(lon: number, lat: number, radiusKm: number, steps = 128): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(lon, lat, (i / steps) * 360, radiusKm));
  return ring;
}

/**
 * Lon/lat bounding boxes that fully contain the spherical cap of `radiusKm` around (lon, lat).
 * Returns one box, or two when the cap straddles the antimeridian. A cap containing a pole spans
 * all longitudes. Used as the API's bounding-box pre-filter; exact distances are computed afterwards.
 */
export function capBoundingBoxes(lon: number, lat: number, radiusKm: number): BBox[] {
  const d = (radiusKm / EARTH_RADIUS_KM) * RAD;
  const minLat = lat - d;
  const maxLat = lat + d;
  if (maxLat >= 90 || minLat <= -90) {
    return [[-180, Math.max(minLat, -90), 180, Math.min(maxLat, 90)]];
  }
  // Maximum longitude extent of a cap (tangent-point formula), exact on the sphere.
  const dLon = Math.asin(Math.min(1, Math.sin(d * DEG) / Math.cos(lat * DEG))) * RAD;
  const w = lon - dLon;
  const e = lon + dLon;
  if (w < -180)
    return [
      [-180, minLat, e, maxLat],
      [w + 360, minLat, 180, maxLat],
    ];
  if (e > 180)
    return [
      [w, minLat, 180, maxLat],
      [-180, minLat, e - 360, maxLat],
    ];
  return [[w, minLat, e, maxLat]];
}

export interface ArcCapIntersection {
  /** Fractions along the arc [0..1] where it enters / leaves the cap; null when it never enters. */
  inside: { t0: number; t1: number } | null;
  /** Fraction along the arc of the point closest to the cap centre, and that central angle (rad). */
  closestT: number;
  closestAngle: number;
}

/**
 * Exact intersection of the short great-circle arc A→B with the spherical cap {X : angle(X, P) ≤ r}.
 *
 * Along the arc X(φ) = (sin(Ω-φ)·A + sin(φ)·B) / sin Ω, so P·X(φ) = α·cos φ + β·sin φ = K·cos(φ-δ)
 * with α = P·A, β = (P·B - P·A·cos Ω) / sin Ω. The arc is inside the cap where K·cos(φ-δ) ≥ cos r,
 * which is the closed interval δ ± acos(cos r / K). This gives entry/exit points (hence AOS/LOS
 * times) analytically instead of by sampling.
 */
export function intersectArcWithCap(a: Vec3, b: Vec3, p: Vec3, cosR: number): ArcCapIntersection {
  const omega = centralAngle(a, b);
  const pa = dot(p, a);
  if (omega < DEGENERATE_ARC_RAD) {
    return { inside: pa >= cosR ? { t0: 0, t1: 1 } : null, closestT: 0, closestAngle: centralAngle(a, p) };
  }
  const alpha = pa;
  const beta = (dot(p, b) - pa * Math.cos(omega)) / Math.sin(omega);
  const k = Math.hypot(alpha, beta);
  const delta = Math.atan2(beta, alpha);

  const closestT = maximizeOnArc(alpha, beta, delta, omega).phi / omega;
  const inside = k > 0 && k >= cosR ? capInterval(delta, Math.acos(Math.min(1, cosR / k)), omega) : null;
  // acos(cos θ) loses ~1e-8 rad (≈ 10 cm) near θ = 0 — i.e. exactly for overhead passes — so the
  // distance is re-measured with the atan2-based centralAngle at the closest point.
  return { inside, closestT, closestAngle: centralAngle(slerp(a, b, closestT), p) };
}

/** Arcs shorter than this (≈ 6 µm on the ground) are treated as a single point. */
const DEGENERATE_ARC_RAD = 1e-12;
/** δ is only known modulo 2π; these shifts bring the relevant copy onto the arc's [0, Ω] range. */
const PERIOD_SHIFTS = [-2 * Math.PI, 0, 2 * Math.PI] as const;

/** Maximum of α·cos φ + β·sin φ over φ ∈ [0, Ω]: at an endpoint or at the interior peak φ = δ (+2πk). */
function maximizeOnArc(
  alpha: number,
  beta: number,
  delta: number,
  omega: number,
): { phi: number; cos: number } {
  const candidates = [
    0,
    omega,
    ...PERIOD_SHIFTS.map((s) => delta + s).filter((phi) => phi > 0 && phi < omega),
  ];
  let best = { phi: 0, cos: -Infinity };
  for (const phi of candidates) {
    const c = alpha * Math.cos(phi) + beta * Math.sin(phi);
    if (c > best.cos) best = { phi, cos: c };
  }
  return best;
}

/** Intersection of [δ-γ, δ+γ] (mod 2π) with [0, Ω], as arc fractions. A cap cuts a short arc at most once. */
function capInterval(delta: number, gamma: number, omega: number): ArcCapIntersection['inside'] {
  for (const shift of PERIOD_SHIFTS) {
    const lo = Math.max(0, delta + shift - gamma);
    const hi = Math.min(omega, delta + shift + gamma);
    if (lo <= hi) return { t0: lo / omega, t1: hi / omega };
  }
  return null;
}

/** Spherical linear interpolation between unit vectors. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const omega = centralAngle(a, b);
  if (omega < DEGENERATE_ARC_RAD) return a;
  const s = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / s;
  const wb = Math.sin(t * omega) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
}
