/**
 * Shareable links: the view state lives in the query string.
 *
 *   ?sats=YAM20,YAM25&from=2027-03-01T06:00Z&to=2027-03-01T12:00Z&proj=flat&map=24.45,54.37,3.2
 *
 * Parsing is syntactic and forgiving: an invalid parameter is dropped, never an error, so a
 * hand-edited or truncated link still opens. Semantic checks (known satellites, dataset bounds)
 * happen when the store is initialized. Defaults are omitted to keep links short.
 */
import { SATELLITE_ID_PATTERN } from '@ow/shared';

import { parseUtcMinute } from '../lib/time';

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

function parseCamera(v: string | null): CameraState | undefined {
  const parts = v?.split(',').map(Number);
  if (parts?.length !== 3 || !parts.every(Number.isFinite)) return undefined;
  const [lat = 0, lon = 0, zoom = 0] = parts;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || zoom < 0 || zoom > MAX_ZOOM) return undefined;
  return { lat, lon, zoom };
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
  return state;
}

export interface SerializableState {
  satellites: readonly string[];
  hidden: ReadonlySet<string>;
  timeWindow: TimeWindow;
  defaultWindow: TimeWindow;
  projection: Projection;
  camera: CameraState | null;
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
  // "," and ":" are valid in a query string (RFC 3986); keeping them literal makes links readable.
  const qs = p.toString().replaceAll('%2C', ',').replaceAll('%3A', ':');
  return qs === '' ? '' : `?${qs}`;
}
