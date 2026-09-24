/**
 * Shareable links: the view state lives in the query string.
 *
 *   ?sats=YAM20,YAM25&from=2027-03-01T06:00Z&to=2027-03-01T12:00Z&proj=flat&map=24.45,54.37,3.2
 *    &pin=24.454,54.377&r=600&afrom=2027-03-02&ato=2027-03-04&daylight=1
 *
 * Parsing is syntactic and forgiving: an invalid parameter is dropped, never an error, so a
 * hand-edited or truncated link still opens. Semantic checks (known satellites, dataset bounds)
 * happen when the store is initialized. Defaults are omitted to keep links short.
 */
import { RADIUS_KM, SATELLITE_ID_PATTERN, normalizeLon } from '@ow/shared';

import { SECONDS_PER_DAY, formatDate, parseUtcDay, parseUtcMinute } from '../lib/time';

import type { TimeWindow } from '../features/timeline/timelineMath';

export type Projection = 'globe' | 'mercator';

export interface CameraState {
  lon: number;
  lat: number;
  zoom: number;
}

export interface UrlState {
  /** Visible satellites; absent means all. */
  satellites?: string[];
  timeWindow?: TimeWindow;
  projection?: Projection;
  camera?: CameraState;
  /** Accesses: pin, radius, query days (UTC midnights, end exclusive) and the daylight filter. */
  pin?: { lat: number; lon: number };
  radiusKm?: number;
  accessDays?: TimeWindow;
  daylightOnly?: boolean;
}

const MAX_ZOOM = 22;
/** Longest accepted list: stops a crafted link from making the app parse megabytes of ids. */
const MAX_URL_SATELLITES = 64;

/** "2027-03-01T06:00Z" → epoch seconds; null for anything else, including impossible dates. */
const parseInstant = (v: string | null): number | null =>
  v?.endsWith('Z') ? parseUtcMinute(v.slice(0, -1)) : null;

/** "2027-03-01T06:00Z": links carry minute precision (the timeline snaps to minutes). */
export const formatInstant = (epochS: number): string =>
  `${new Date(Math.round(epochS / 60) * 60_000).toISOString().slice(0, 16)}Z`;

function parseSatellites(v: string | null): string[] | undefined {
  if (v === null) return undefined;
  if (v === '') return [];
  // The split limit bounds the work on a crafted link, not just the result.
  const ids = v.split(',', MAX_URL_SATELLITES);
  return ids.every((id) => SATELLITE_ID_PATTERN.test(id)) ? [...new Set(ids)] : undefined;
}

/** "lat,lon[,…]": exactly `count` finite numbers, the first two a valid latitude and longitude. */
function parseLatLonTuple(v: string | null, count: number): number[] | undefined {
  const parts = v?.split(',', count + 1).map(Number);
  if (parts?.length !== count || !parts.every(Number.isFinite)) return undefined;
  const [lat = 0, lon = 0] = parts;
  return Math.abs(lat) > 90 || Math.abs(lon) > 180 ? undefined : parts;
}

function parseCamera(v: string | null): CameraState | undefined {
  const [lat = 0, lon = 0, zoom = -1] = parseLatLonTuple(v, 3) ?? [];
  return zoom >= 0 && zoom <= MAX_ZOOM ? { lat, lon, zoom } : undefined;
}

function parsePin(v: string | null): { lat: number; lon: number } | undefined {
  const parts = parseLatLonTuple(v, 2);
  // Longitudes are [-180, 180) everywhere in the app: a link with 180 means -180.
  return parts ? { lat: parts[0] ?? 0, lon: normalizeLon(parts[1] ?? 0) } : undefined;
}

function parseAccess(p: URLSearchParams, state: UrlState): void {
  const pin = parsePin(p.get('pin'));
  if (pin) state.pin = pin;
  const radius = Number(p.get('r') ?? Number.NaN);
  if (Number.isInteger(radius) && radius >= RADIUS_KM.min && radius <= RADIUS_KM.max) state.radiusKm = radius;
  const from = parseUtcDay(p.get('afrom') ?? '');
  const to = parseUtcDay(p.get('ato') ?? '');
  // `ato` is the last day, inclusive.
  if (from !== null && to !== null && to >= from)
    state.accessDays = { startS: from, endS: to + SECONDS_PER_DAY };
  if (p.get('daylight') === '1') state.daylightOnly = true;
}

export function parseUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  const state: UrlState = {};
  const satellites = parseSatellites(p.get('sats'));
  if (satellites) state.satellites = satellites;
  const from = parseInstant(p.get('from'));
  const to = parseInstant(p.get('to'));
  if (from !== null && to !== null && to > from) state.timeWindow = { startS: from, endS: to };
  const proj = p.get('proj');
  if (proj === 'flat') state.projection = 'mercator';
  if (proj === 'globe') state.projection = 'globe';
  const camera = parseCamera(p.get('map'));
  if (camera) state.camera = camera;
  parseAccess(p, state);
  return state;
}

export interface SerializableState {
  satellites: readonly string[];
  hidden: ReadonlySet<string>;
  timeWindow: TimeWindow;
  defaultWindow: TimeWindow;
  projection: Projection;
  camera: CameraState | null;
  access?: {
    pin: { lat: number; lon: number } | null;
    radiusKm: number;
    startS: number;
    endS: number;
    daylightOnly: boolean;
  };
  /** Query days when none were chosen (the whole dataset). */
  defaultAccessDays?: TimeWindow;
}

function writeAccess(p: URLSearchParams, s: SerializableState): void {
  const { access, defaultAccessDays } = s;
  if (!access?.pin) return;
  // ~100 m precision: plenty for a pin, and short links.
  p.set('pin', `${access.pin.lat.toFixed(3)},${access.pin.lon.toFixed(3)}`);
  if (access.radiusKm !== RADIUS_KM.default) p.set('r', String(access.radiusKm));
  if (access.startS !== defaultAccessDays?.startS || access.endS !== defaultAccessDays.endS) {
    p.set('afrom', formatDate(access.startS));
    p.set('ato', formatDate(access.endS - SECONDS_PER_DAY));
  }
  if (access.daylightOnly) p.set('daylight', '1');
}

/** Query string for the state (with leading "?"), or "" when everything is at its default. */
export function serializeUrlState(s: SerializableState): string {
  const p = new URLSearchParams();
  if (s.hidden.size > 0) p.set('sats', s.satellites.filter((id) => !s.hidden.has(id)).join(','));
  if (s.timeWindow.startS !== s.defaultWindow.startS || s.timeWindow.endS !== s.defaultWindow.endS) {
    p.set('from', formatInstant(s.timeWindow.startS));
    p.set('to', formatInstant(s.timeWindow.endS));
  }
  if (s.projection === 'mercator') p.set('proj', 'flat');
  if (s.camera) {
    const { lat, lon, zoom } = s.camera;
    p.set('map', `${lat.toFixed(2)},${lon.toFixed(2)},${zoom.toFixed(1)}`);
  }
  writeAccess(p, s);
  // "," and ":" are valid in a query string (RFC 3986); keeping them literal makes links readable.
  const qs = p.toString().replaceAll('%2C', ',').replaceAll('%3A', ':');
  return qs === '' ? '' : `?${qs}`;
}
