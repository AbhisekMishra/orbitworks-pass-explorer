export interface SegmentFilter {
  satellites?: readonly string[];
  /** Keep segments overlapping [startMs, endMs). */
  startMs?: number;
  endMs?: number;
}

export interface SatelliteRow {
  id: string;
  startMs: number;
  endMs: number;
  segmentCount: number;
  minAltitudeKm: number;
  maxAltitudeKm: number;
}
