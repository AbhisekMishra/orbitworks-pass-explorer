/**
 * All track vertices as unit vectors in flat typed arrays (struct-of-arrays), loaded once at boot.
 *
 * Why: converting DuckDB's nested coordinate lists to JS objects costs ~130 ms for a large query,
 * while fetching candidate segment *ids* costs ~15 ms. So DuckDB acts as the candidate filter (vectorised bbox/time/cap predicates)
 * and the exact geometry runs here on contiguous Float64Arrays — dot products with no allocation
 * and no trigonometry in the hot loop. Memory: 5 × 8 B + 4 B per vertex (~30 MB for the week).
 */
import { EARTH_RADIUS_KM, centralAngle, toVec, type Vec3 } from '@ow/shared';

/**
 * Upper bound for the length of one 10-second arc (the data has ~76 km). Used to reject arcs that
 * cannot reach the circle without any trigonometry; enforced when the geometry is built.
 */
export const MAX_ARC_KM = 200;
export const MAX_ARC_RAD = MAX_ARC_KM / EARTH_RADIUS_KM;

export interface TrackGeometry {
  readonly segmentCount: number;
  readonly satellites: readonly string[];
  /** Per segment: index into `satellites`. */
  readonly satelliteIndex: Uint16Array;
  readonly startMs: Float64Array;
  readonly endMs: Float64Array;
  /** Per segment: first vertex index; entry `segmentCount` closes the last segment. */
  readonly vertexStart: Int32Array;
  /** Per vertex: lon/lat (degrees, for output without trigonometry), unit vector, altitude. */
  readonly lon: Float64Array;
  readonly lat: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly altKm: Float32Array;
}

export interface GeometryColumns {
  satellite: readonly string[];
  startMs: ArrayLike<number>;
  endMs: ArrayLike<number>;
  vertexCount: ArrayLike<number>;
  /** Flattened vertices of all segments, in segment order. */
  lon: ArrayLike<number>;
  lat: ArrayLike<number>;
  altKm: ArrayLike<number>;
}

export function vertexVec(g: TrackGeometry, v: number): Vec3 {
  return [Number(g.x[v]), Number(g.y[v]), Number(g.z[v])];
}

function assertShortArcs(g: TrackGeometry): void {
  for (let s = 0; s < g.segmentCount; s++) {
    for (let v = Number(g.vertexStart[s]); v < Number(g.vertexStart[s + 1]) - 1; v++) {
      if (centralAngle(vertexVec(g, v), vertexVec(g, v + 1)) > MAX_ARC_RAD) {
        throw new Error(
          `Segment ${s} has an arc longer than ${MAX_ARC_KM} km; the pass engine assumes shorter arcs`,
        );
      }
    }
  }
}

export function buildGeometry(c: GeometryColumns): TrackGeometry {
  const segmentCount = c.satellite.length;
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const satelliteIndex = new Uint16Array(segmentCount);
  const vertexStart = new Int32Array(segmentCount + 1);
  let cursor = 0;
  for (let s = 0; s < segmentCount; s++) {
    const name = String(c.satellite[s]);
    let index = nameIndex.get(name);
    if (index === undefined) {
      index = names.push(name) - 1;
      nameIndex.set(name, index);
    }
    satelliteIndex[s] = index;
    vertexStart[s] = cursor;
    cursor += Number(c.vertexCount[s]);
  }
  vertexStart[segmentCount] = cursor;
  if (cursor !== c.lon.length) throw new Error('Vertex counts do not match the flattened vertex columns');

  const x = new Float64Array(cursor);
  const y = new Float64Array(cursor);
  const z = new Float64Array(cursor);
  for (let v = 0; v < cursor; v++) {
    [x[v], y[v], z[v]] = toVec(Number(c.lon[v]), Number(c.lat[v]));
  }
  const geometry: TrackGeometry = {
    segmentCount,
    satellites: names,
    satelliteIndex,
    startMs: Float64Array.from(c.startMs),
    endMs: Float64Array.from(c.endMs),
    vertexStart,
    lon: Float64Array.from(c.lon),
    lat: Float64Array.from(c.lat),
    x,
    y,
    z,
    altKm: Float32Array.from(c.altKm),
  };
  assertShortArcs(geometry);
  return geometry;
}
