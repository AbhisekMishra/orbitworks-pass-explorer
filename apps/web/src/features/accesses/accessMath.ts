/**
 * Pure helpers for the accesses feature: grouping, CSV export, pass geometry for the map and the
 * radius ↔ elevation relation shown next to the radius control.
 */
import {
  EARTH_RADIUS_KM,
  MS_PER_SECOND,
  RADIUS_KM,
  elevationDeg,
  geodesicCircle,
  normalizeLon,
  type AccessesResponse,
  type Pass,
} from '@ow/shared';

import { toEpochS } from '../../lib/time';
import { sampleTrack } from '../../map/trackQueries';
import { RENDER_ALTITUDE_M, type TrackBuffers } from '../../tracks/trackBuffers';

export interface DayGroup {
  /** "2027-03-01" (UTC). */
  day: string;
  passes: Pass[];
}

/** Passes grouped by UTC day of their start, in chronological order. */
export function groupPassesByDay(passes: readonly Pass[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const pass of [...passes].sort((a, b) => a.start.localeCompare(b.start))) {
    const day = pass.start.slice(0, 10);
    const last = groups.at(-1);
    if (last?.day === day) last.passes.push(pass);
    else groups.push({ day, passes: [pass] });
  }
  return groups;
}

/**
 * Elevation above the horizon at the edge of the circle for a satellite at `altitudeKm`: the
 * radius control shows it so users can think in "visible above 20°" terms.
 */
export const edgeElevationDeg = (radiusKm: number, altitudeKm: number): number =>
  elevationDeg(radiusKm / EARTH_RADIUS_KM, altitudeKm);

// ---------------------------------------------------------------------------------------------
// Geometry for the map

/** Makes longitudes continuous (no ±360° jumps), so a ring or path crossing 180° draws as one piece. */
export function unwrapLongitudes(points: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  let prev: number | null = null;
  for (const [lon, lat] of points) {
    const next: number = prev === null ? lon : prev + normalizeLon(lon - prev);
    out.push([next, lat]);
    prev = next;
  }
  return out;
}

export interface CircleRing {
  ring: [number, number][];
  /** A circle around a pole cannot be drawn as a simple polygon: only its outline is drawn. */
  enclosesPole: boolean;
}

export function circleRing(lon: number, lat: number, radiusKm: number): CircleRing {
  const ring = unwrapLongitudes(geodesicCircle(lon, lat, radiusKm));
  const first = ring[0];
  const last = ring.at(-1);
  // A ring that winds around a pole ends 360° away from where it started.
  const enclosesPole = first !== undefined && last !== undefined && Math.abs(last[0] - first[0]) > 180;
  return { ring, enclosesPole };
}

/** The circle as GeoJSON for the map: a fill polygon and an outline (outline only around a pole). */
export type CircleData = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.LineString>;

export function circleData(pin: { lon: number; lat: number } | null, radiusKm: number): CircleData {
  if (!pin) return { type: 'FeatureCollection', features: [] };
  const { ring, enclosesPole } = circleRing(pin.lon, pin.lat, radiusKm);
  const outline: GeoJSON.Feature<GeoJSON.LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: ring },
  };
  // A ring around a pole is not a simple polygon: draw its outline only.
  if (enclosesPole) return { type: 'FeatureCollection', features: [outline] };
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
      outline,
    ],
  };
}

/**
 * The part of a track flown during a pass: interpolated endpoints plus every sample in between.
 * Rebuilt from the tracks already in memory, so the API does not send paths (ADR-004).
 */
export function passPath(track: TrackBuffers, startS: number, endS: number): [number, number][] {
  const points: [number, number][] = [];
  const add = (tS: number): void => {
    const p = sampleTrack(track, tS);
    if (p) points.push([p.lon, p.lat]);
  };
  add(startS);
  const first = Math.floor((startS - track.startS) / track.stepS) + 1;
  for (let i = first; track.startS + i * track.stepS < endS; i++) add(track.startS + i * track.stepS);
  add(endS);
  return unwrapLongitudes(points);
}

// ---------------------------------------------------------------------------------------------
// CSV export

const CSV_COLUMNS = [
  'satellite',
  'start_utc',
  'end_utc',
  'duration_s',
  'closest_approach_utc',
  'min_distance_km',
  'max_elevation_deg',
  'sun_elevation_deg',
  'daylight',
  'direction',
  'local_solar_time_h',
  'altitude_km',
] as const;

/** Leading characters a spreadsheet would treat as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * RFC 4180 field: quoted when it contains a separator, quote or line break. Text that would start
 * a spreadsheet formula gets a leading apostrophe (CSV injection); numbers stay numbers.
 */
const csvField = (value: string | number | boolean): string => {
  const s = typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function passesToCsv(passes: readonly Pass[]): string {
  const rows = passes.map((p) =>
    [
      p.satellite,
      p.start,
      p.end,
      p.durationS,
      p.tca,
      p.minDistanceKm,
      p.maxElevationDeg,
      p.sunElevationDeg,
      p.daylight,
      p.direction,
      p.localSolarTimeH,
      p.altitudeKm,
    ]
      .map(csvField)
      .join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

/** "passes_24.45N_54.37E_400km_2027-03-01_2027-03-07.csv" */
export function csvFileName(q: AccessesResponse['query']): string {
  const lat = `${Math.abs(q.lat).toFixed(2)}${q.lat < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(q.lon).toFixed(2)}${q.lon < 0 ? 'W' : 'E'}`;
  // The query end is exclusive (midnight after the last day).
  const lastDay = new Date((toEpochS(q.end) - 1) * MS_PER_SECOND).toISOString().slice(0, 10);
  return `passes_${lat}_${lon}_${Math.round(q.radiusKm)}km_${q.start.slice(0, 10)}_${lastDay}.csv`;
}

// ---------------------------------------------------------------------------------------------
// Radius slider (logarithmic: 10–2,500 km spans 2.4 orders of magnitude)

export const RADIUS_SLIDER_STEPS = 1000;

/** Readable radii: 5 km steps up to 100 km, 10 km up to 1,000 km, 50 km beyond. */
const RADIUS_STEPS: readonly [upToKm: number, stepKm: number][] = [
  [100, 5],
  [1000, 10],
  [Infinity, 50],
];

export function roundRadius(km: number): number {
  const step = RADIUS_STEPS.find(([upTo]) => km <= upTo)?.[1] ?? 50;
  return Math.round(km / step) * step;
}

export function radiusToSlider(km: number): number {
  const f = Math.log(km / RADIUS_KM.min) / Math.log(RADIUS_KM.max / RADIUS_KM.min);
  return Math.round(Math.min(Math.max(f, 0), 1) * RADIUS_SLIDER_STEPS);
}

export function sliderToRadius(value: number): number {
  const f = Math.min(Math.max(value / RADIUS_SLIDER_STEPS, 0), 1);
  const km = RADIUS_KM.min * (RADIUS_KM.max / RADIUS_KM.min) ** f;
  return Math.min(Math.max(roundRadius(km), RADIUS_KM.min), RADIUS_KM.max);
}

// ---------------------------------------------------------------------------------------------
// Pass portions for the map

export interface PassPortion {
  id: string;
  satellite: string;
  startS: number;
  endS: number;
  /** [lon, lat, altM], continuous longitudes, drawn at the tracks' render altitude. */
  path: [number, number, number][];
  color: readonly [number, number, number];
}

/** Map geometry for each pass whose satellite track and color are known. */
export function passPortions(
  passes: readonly Pass[],
  tracks: readonly TrackBuffers[],
  colors: ReadonlyMap<string, { rgb: readonly [number, number, number] }>,
): PassPortion[] {
  const bySatellite = new Map(tracks.map((t) => [t.satellite, t]));
  return passes.flatMap((pass) => {
    const track = bySatellite.get(pass.satellite);
    const color = colors.get(pass.satellite);
    if (!track || !color) return [];
    const startS = toEpochS(pass.start);
    const endS = toEpochS(pass.end);
    const path = passPath(track, startS, endS).map(([lon, lat]): [number, number, number] => [
      lon,
      lat,
      RENDER_ALTITUDE_M,
    ]);
    return path.length < 2
      ? []
      : [{ id: pass.id, satellite: pass.satellite, startS, endS, path, color: color.rgb }];
  });
}
