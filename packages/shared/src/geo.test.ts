import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EARTH_RADIUS_KM } from './constants.js';
import {
  capBoundingBoxes,
  centralAngle,
  destination,
  distanceKm,
  elevationDeg,
  geodesicCircle,
  groundRangeKmForElevation,
  intersectArcWithCap,
  normalizeHours,
  normalizeLon,
  slerp,
  toDeg,
  toLonLat,
  toRad,
  toVec,
  type BBox,
} from './geo.js';

const KM_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_KM; // ≈ 111.195 km

const lonArb = fc.double({ min: -179.999, max: 179.999, noNaN: true });
const latArb = fc.double({ min: -85, max: 85, noNaN: true });

const inBox = ([lon, lat]: readonly [number, number], [w, s, e, n]: BBox, eps = 1e-9) =>
  lon >= w - eps && lon <= e + eps && lat >= s - eps && lat <= n + eps;

describe('unit conversions', () => {
  it('converts degrees and radians both ways', () => {
    expect(toRad(180)).toBeCloseTo(Math.PI, 12);
    expect(toDeg(Math.PI / 2)).toBeCloseTo(90, 12);
  });

  it('round-trips lon/lat through unit vectors', () => {
    fc.assert(
      fc.property(lonArb, latArb, (lon, lat) => {
        const [lo, la] = toLonLat(toVec(lon, lat));
        expect(lo).toBeCloseTo(lon, 9);
        expect(la).toBeCloseTo(lat, 9);
      }),
    );
  });
});

describe('distances', () => {
  it('matches known great-circle distances', () => {
    expect(distanceKm([0, 0], [1, 0])).toBeCloseTo(KM_PER_DEG, 6);
    expect(distanceKm([0, 0], [180, 0])).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 6);
    expect(distanceKm([10, 20], [10, 20])).toBe(0);
    // Across the antimeridian the short way round is 2°, not 358°.
    expect(distanceKm([179, 0], [-179, 0])).toBeCloseTo(2 * KM_PER_DEG, 6);
  });

  it('is symmetric and stable for tiny angles', () => {
    const rome = toVec(12.5, 41.9);
    const romeNudged = toVec(12.500001, 41.9);
    const forward = centralAngle(rome, romeNudged);
    const backward = centralAngle(romeNudged, rome);
    expect(forward).toBeGreaterThan(0);
    expect(forward).toBeCloseTo(backward, 15);
  });
});

describe('normalizeLon / normalizeHours', () => {
  it.each([
    [0, 0],
    [180, -180],
    [-180, -180],
    [190, -170],
    [-190, 170],
    [540, -180],
    [359.5, -0.5],
  ])('normalizeLon(%d) = %d', (input, expected) => {
    expect(normalizeLon(input)).toBeCloseTo(expected, 9);
  });

  it('returns in-range longitudes exactly (no float noise from the wrapping arithmetic)', () => {
    for (const lon of [54.377, -122.4194, 179.99999, -180, 0.1]) expect(normalizeLon(lon)).toBe(lon);
  });

  it.each([
    [-1.5, 22.5],
    [25.5, 1.5],
    [24, 0],
    [-11.9, 12.1],
    [35.9, 11.9],
    [10.5, 10.5],
  ])('normalizeHours(%d) = %d', (input, expected) => {
    expect(normalizeHours(input)).toBeCloseTo(expected, 9);
  });
});

describe('elevation', () => {
  it('is 90° directly overhead and ~0° at the horizon range', () => {
    expect(elevationDeg(0, 500)).toBeCloseTo(90, 9);
    const horizonKm = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + 500)) * EARTH_RADIUS_KM;
    expect(groundRangeKmForElevation(0, 500)).toBeCloseTo(horizonKm, 6);
    expect(elevationDeg(horizonKm / EARTH_RADIUS_KM, 500)).toBeCloseTo(0, 6);
  });

  it('is negative beyond the horizon', () => {
    expect(elevationDeg(3000 / EARTH_RADIUS_KM, 500)).toBeLessThan(0);
  });

  it('inverts groundRangeKmForElevation', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 89.9, noNaN: true }),
        fc.double({ min: 300, max: 1200, noNaN: true }),
        (elev, alt) => {
          const range = groundRangeKmForElevation(elev, alt);
          expect(elevationDeg(range / EARTH_RADIUS_KM, alt)).toBeCloseTo(elev, 6);
        },
      ),
    );
  });
});

describe('destination & geodesicCircle', () => {
  it('travels north along a meridian', () => {
    const [lon, lat] = destination(0, 0, 0, KM_PER_DEG);
    expect(lon).toBeCloseTo(0, 9);
    expect(lat).toBeCloseTo(1, 9);
  });

  it('wraps across the antimeridian', () => {
    const [lon] = destination(179.5, 0, 90, KM_PER_DEG);
    expect(lon).toBeCloseTo(-179.5, 6);
  });

  it('lands exactly at the requested distance', () => {
    fc.assert(
      fc.property(
        lonArb,
        latArb,
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 1, max: 3000, noNaN: true }),
        (lon, lat, bearing, d) => {
          expect(distanceKm([lon, lat], destination(lon, lat, bearing, d))).toBeCloseTo(d, 6);
        },
      ),
    );
  });

  it('builds a closed ring on the circle', () => {
    const ring = geodesicCircle(55, 25, 400, 64);
    expect(ring).toHaveLength(65);
    expect(ring[0]?.[0]).toBeCloseTo(ring[64]?.[0] ?? NaN, 9);
    expect(ring[0]?.[1]).toBeCloseTo(ring[64]?.[1] ?? NaN, 9);
    for (const p of ring) expect(distanceKm([55, 25], p)).toBeCloseTo(400, 6);
  });
});

describe('capBoundingBoxes', () => {
  it('returns a single box away from the antimeridian and poles', () => {
    const boxes = capBoundingBoxes(55, 25, 400);
    expect(boxes).toHaveLength(1);
    const [w, s, e, n] = boxes[0] ?? [];
    expect(n! - s!).toBeCloseTo((2 * 400) / KM_PER_DEG, 9);
    expect(e! - w!).toBeGreaterThan(n! - s!); // longitudes stretch away from the equator
  });

  it('splits in two across the antimeridian (both sides)', () => {
    const east = capBoundingBoxes(179.5, 0, 200);
    expect(east).toHaveLength(2);
    expect(east.some(([w, , e]) => w === -180 && e < -178)).toBe(true);
    const west = capBoundingBoxes(-179.5, 0, 200);
    expect(west).toHaveLength(2);
    expect(west.some(([w, , e]) => e === 180 && w > 178)).toBe(true);
  });

  it('spans all longitudes when the cap contains a pole', () => {
    expect(capBoundingBoxes(10, 88, 500)).toEqual([[-180, expect.any(Number), 180, 90]]);
    expect(capBoundingBoxes(10, -88, 500)).toEqual([[-180, -90, 180, expect.any(Number)]]);
  });

  it('contains every point of the cap boundary (property)', () => {
    fc.assert(
      fc.property(lonArb, latArb, fc.double({ min: 10, max: 2500, noNaN: true }), (lon, lat, r) => {
        const boxes = capBoundingBoxes(lon, lat, r);
        for (const p of geodesicCircle(lon, lat, r, 90)) {
          expect(boxes.some((b) => inBox(p, b, 1e-6))).toBe(true);
        }
      }),
    );
  });
});

describe('slerp', () => {
  it('hits both endpoints and stays on the unit sphere', () => {
    const a = toVec(0, 0);
    const b = toVec(10, 10);
    expect(centralAngle(slerp(a, b, 0), a)).toBeLessThan(1e-12);
    expect(centralAngle(slerp(a, b, 1), b)).toBeLessThan(1e-12);
    const mid = slerp(a, b, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 12);
    expect(centralAngle(a, mid)).toBeCloseTo(centralAngle(mid, b), 12);
  });

  it('returns the start point for a degenerate arc', () => {
    const a = toVec(5, 5);
    expect(slerp(a, a, 0.7)).toBe(a);
  });
});

describe('intersectArcWithCap', () => {
  const cosOf = (km: number) => Math.cos(km / EARTH_RADIUS_KM);

  it('reports an arc passing through the centre as symmetric and inside', () => {
    const a = toVec(-1, 0);
    const b = toVec(1, 0);
    const res = intersectArcWithCap(a, b, toVec(0, 0), cosOf(KM_PER_DEG / 2));
    expect(res.inside?.t0).toBeCloseTo(0.25, 9);
    expect(res.inside?.t1).toBeCloseTo(0.75, 9);
    expect(res.closestT).toBeCloseTo(0.5, 9);
    expect(res.closestAngle).toBeCloseTo(0, 9);
  });

  it('returns null when the arc misses the cap, with the correct closest approach', () => {
    const res = intersectArcWithCap(toVec(-1, 2), toVec(1, 2), toVec(0, 0), cosOf(100));
    expect(res.inside).toBeNull();
    expect(res.closestT).toBeCloseTo(0.5, 6);
    expect(res.closestAngle * EARTH_RADIUS_KM).toBeCloseTo(2 * KM_PER_DEG, 0);
  });

  it('handles an arc fully inside the cap', () => {
    const res = intersectArcWithCap(toVec(-0.1, 0), toVec(0.1, 0), toVec(0, 0), cosOf(500));
    expect(res.inside).toEqual({ t0: 0, t1: 1 });
  });

  it('handles an arc that starts inside and leaves', () => {
    const res = intersectArcWithCap(toVec(0, 0), toVec(2, 0), toVec(0, 0), cosOf(KM_PER_DEG));
    expect(res.inside?.t0).toBe(0);
    expect(res.inside?.t1).toBeCloseTo(0.5, 9);
    expect(res.closestT).toBe(0);
  });

  it('works across the antimeridian', () => {
    const res = intersectArcWithCap(toVec(179.5, 0), toVec(-179.5, 0), toVec(180, 0), cosOf(KM_PER_DEG / 4));
    expect(res.inside?.t0).toBeCloseTo(0.25, 9);
    expect(res.inside?.t1).toBeCloseTo(0.75, 9);
  });

  it('treats a degenerate arc as a point', () => {
    const p = toVec(0, 0);
    expect(intersectArcWithCap(p, p, p, cosOf(10)).inside).toEqual({ t0: 0, t1: 1 });
    const far = toVec(5, 5);
    const res = intersectArcWithCap(far, far, p, cosOf(10));
    expect(res.inside).toBeNull();
    expect(res.closestAngle).toBeCloseTo(centralAngle(far, p), 12);
  });

  it('agrees with brute-force sampling on random arcs (property)', () => {
    const SAMPLES = 400;
    fc.assert(
      fc.property(
        lonArb,
        fc.double({ min: -82, max: 82, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 1, max: 120, noNaN: true }), // arc length (km); tracks use ~75 km arcs
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0, max: 400, noNaN: true }), // cap centre offset from arc start
        fc.double({ min: 10, max: 300, noNaN: true }), // radius
        (lon, lat, bearing, lenKm, cBearing, cDist, rKm) => {
          const a = toVec(lon, lat);
          const b = toVec(...destination(lon, lat, bearing, lenKm));
          const p = toVec(...destination(lon, lat, cBearing, cDist));
          const res = intersectArcWithCap(a, b, p, cosOf(rKm));

          const rAngle = rKm / EARTH_RADIUS_KM;
          const tol = 1.5 / SAMPLES; // sampling resolution
          let minAngle = Infinity;
          let anyInside = false;
          for (let i = 0; i <= SAMPLES; i++) {
            const t = i / SAMPLES;
            const ang = centralAngle(slerp(a, b, t), p);
            minAngle = Math.min(minAngle, ang);
            // Only assert on samples clearly inside/outside the boundary (avoid float ties).
            if (ang < rAngle * (1 - 1e-9)) {
              anyInside = true;
              expect(res.inside).not.toBeNull();
              expect(t).toBeGreaterThanOrEqual((res.inside?.t0 ?? 0) - tol);
              expect(t).toBeLessThanOrEqual((res.inside?.t1 ?? 1) + tol);
            } else if (ang > rAngle * (1 + 1e-9) && res.inside) {
              expect(t < res.inside.t0 + tol || t > res.inside.t1 - tol).toBe(true);
            }
          }
          if (!anyInside && res.inside) {
            // Analytic interval can be a sliver between samples: it must still be (nearly) tangent.
            expect(res.inside.t1 - res.inside.t0).toBeLessThan(2 * tol);
          }
          expect(res.closestAngle).toBeLessThanOrEqual(minAngle + 1e-12);
          expect(res.closestAngle).toBeGreaterThan(minAngle - (lenKm / EARTH_RADIUS_KM) * tol);
        },
      ),
      { numRuns: 300 },
    );
  });
});
