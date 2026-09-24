import { buildGeometry, type TrackGeometry } from '../src/domain/geometry.js';

/** One source-like segment (a 1-minute LineString) for building small test geometries. */
export interface Segment {
  satellite: string;
  startMs: number;
  endMs: number;
  /** [lon, lat, altKm] vertices, evenly spaced in time between startMs and endMs. */
  coords: readonly (readonly [number, number, number])[];
}

/** Test geometry from plain segments: segment ids are the array indices. */
export function geometryFromSegments(segments: readonly Segment[]): TrackGeometry {
  return buildGeometry({
    satellite: segments.map((s) => s.satellite),
    startMs: segments.map((s) => s.startMs),
    endMs: segments.map((s) => s.endMs),
    vertexCount: segments.map((s) => s.coords.length),
    lon: segments.flatMap((s) => s.coords.map((c) => c[0])),
    lat: segments.flatMap((s) => s.coords.map((c) => c[1])),
    altKm: segments.flatMap((s) => s.coords.map((c) => c[2])),
  });
}
