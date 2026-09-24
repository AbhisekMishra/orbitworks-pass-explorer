/**
 * deck.gl layers from the app state. Called on every relevant state change (up to once per
 * frame while playing): it only creates lightweight layer descriptors. The heavy per-chunk data
 * objects are memoized, so deck.gl diffs props and updates uniforms without touching the GPU buffers.
 *
 * One TrackLayer per satellite and 12 h chunk (see trackChunks.ts): only chunks overlapping the
 * window are visible, so GPU work follows the window length rather than the whole week.
 */
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';

import type { TimeWindow } from '../features/timeline/timelineMath';
import type { MapHover } from '../state/store';
import {
  POSITION_SIZE,
  RENDER_ALTITUDE_M,
  type LoadedTracks,
  type TrackBuffers,
} from '../tracks/trackBuffers';

import type { SatelliteColor } from './colors';
import { chunkOverlaps, chunkTrack, type TrackChunk } from './trackChunks';
import { nearestOnPath, sampleTrack } from './trackQueries';
import { TrackLayer } from './TrackLayer';

export const TRACK_LAYER_PREFIX = 'track:';
export const HEADS_LAYER_ID = 'satellite-heads';
export const PASSES_LAYER_ID = 'access-passes';
const PASSES_OUTLINE_LAYER_ID = 'access-passes-outline';

const TRACK_WIDTH_PX = 2;
const FOCUSED_WIDTH_SCALE = 1.75;
/** Opacity of the other satellites while one is focused from the side panel. */
const DIMMED_OPACITY = 0.12;
/** Oldest samples in the window are drawn at this opacity: shows the direction of travel. */
const TRAIL_FADE_FLOOR = 0.35;
const HIGHLIGHT_RGBA: [number, number, number, number] = [255, 255, 255, 220];
const HEAD_RADIUS_PX = 5;
const HEAD_OUTLINE_RGB: [number, number, number] = [11, 16, 32];
/** While a pin is set the regular tracks recede so the matching pass portions stand out. */
const TRACKS_WITH_PIN_OPACITY = 0.3;
const PASS_WIDTH_PX = 3;
const PASS_EMPHASIS_WIDTH_PX = 7;
/** Passes outside the timeline window stay visible but faint: the window picks the ones that pop. */
const PASS_OUTSIDE_WINDOW_ALPHA = 70;
const OPAQUE = 255;
/** Dark halo under pass portions: readable over any track color and on the dark basemap. */
const PASS_OUTLINE_PX = 3;
const PASS_OUTLINE_RGBA: [number, number, number, number] = [3, 5, 11, 200];

export interface LayerInput {
  tracks: LoadedTracks;
  colors: ReadonlyMap<string, SatelliteColor>;
  timeWindow: TimeWindow;
  hidden: ReadonlySet<string>;
  focusedSatellite: string | null;
  /** Basemap layer to draw beneath (keeps place labels readable above the tracks). */
  beforeId?: string;
  /** Accesses: the portions of track inside the circle, and which one is emphasized. */
  passes?: readonly PassPath[];
  hoveredPassId?: string | null;
  selectedPassId?: string | null;
  pinActive?: boolean;
}

/** A pass portion ready to draw: [lon, lat, altM] vertices with continuous longitudes. */
export interface PassPath {
  id: string;
  satellite: string;
  /** Epoch seconds: passes inside the timeline window are drawn at full strength. */
  startS: number;
  endS: number;
  path: [number, number, number][];
  color: readonly [number, number, number];
}

/**
 * Interleaved-mode placement read by @deck.gl/mapbox from layer props at runtime (its
 * LayerOverlayProps). deck.gl's LayerProps type does not declare it, so it is spread in.
 */
const placement = (beforeId: string | undefined): { beforeId?: string } => (beforeId ? { beforeId } : {});

interface BinaryPaths {
  length: number;
  startIndices: Uint32Array;
  attributes: {
    getPath: { value: Float32Array; size: typeof POSITION_SIZE };
    getTimestamps: { value: Float32Array; size: 1 };
  };
}

interface RenderChunk extends TrackChunk {
  /** Stable binary data object: a new object would make deck.gl re-tessellate and re-upload. */
  data: BinaryPaths;
}

const chunkCache = new WeakMap<TrackBuffers, RenderChunk[]>();
/** The track's chunks with their deck.gl binary data, built once per track. */
export function renderChunksOf(track: TrackBuffers): RenderChunk[] {
  let chunks = chunkCache.get(track);
  if (!chunks) {
    chunks = chunkTrack(track).map((chunk) => ({
      ...chunk,
      data: {
        length: chunk.startIndices.length,
        startIndices: chunk.startIndices,
        attributes: {
          getPath: { value: chunk.positions, size: POSITION_SIZE },
          getTimestamps: { value: chunk.times, size: 1 },
        },
      },
    }));
    chunkCache.set(track, chunks);
  }
  return chunks;
}

export const trackLayerId = (satellite: string, chunk: number): string =>
  `${TRACK_LAYER_PREFIX}${satellite}:${chunk}`;

/** Satellite ids never contain ':' (SATELLITE_ID_PATTERN), so the last ':' splits the id. */
function parseTrackLayerId(id: string): { satellite: string; chunk: number } | null {
  if (!id.startsWith(TRACK_LAYER_PREFIX)) return null;
  const rest = id.slice(TRACK_LAYER_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  const chunk = Number(rest.slice(sep + 1));
  return sep > 0 && Number.isInteger(chunk) ? { satellite: rest.slice(0, sep), chunk } : null;
}

export interface SatelliteHead {
  satellite: string;
  timeS: number;
  /** [lon, lat, altM]: drawn at the same height as the tracks. */
  position: [number, number, number];
  altKm: number;
  color: readonly [number, number, number];
}

/** Where each visible satellite is at the end of the window (clamped to its own track span). */
export function satelliteHeads(input: LayerInput): SatelliteHead[] {
  const heads: SatelliteHead[] = [];
  for (const track of input.tracks.tracks) {
    if (input.hidden.has(track.satellite) || track.lon.length === 0) continue;
    const lastS = track.startS + (track.lon.length - 1) * track.stepS;
    const timeS = Math.min(Math.max(input.timeWindow.endS, track.startS), lastS);
    const sample = sampleTrack(track, timeS);
    const color = input.colors.get(track.satellite);
    if (!sample || !color) continue;
    heads.push({
      satellite: track.satellite,
      timeS,
      position: [sample.lon, sample.lat, RENDER_ALTITUDE_M],
      altKm: sample.altKm,
      color: color.rgb,
    });
  }
  return heads;
}

export function buildLayers(input: LayerInput): Layer[] {
  const { tracks, colors, timeWindow, hidden, beforeId, pinActive = false } = input;
  // A hidden satellite cannot be the focus (e.g. hidden from the panel row under the pointer):
  // otherwise every other satellite would stay dimmed while nothing is emphasized.
  const focus =
    input.focusedSatellite !== null && !hidden.has(input.focusedSatellite) ? input.focusedSatellite : null;
  const windowStartRelS = timeWindow.startS - tracks.t0S;
  const windowEndRelS = timeWindow.endS - tracks.t0S;

  const trackLayers = tracks.tracks.flatMap((track) => {
    const focused = focus === track.satellite;
    const shown = !hidden.has(track.satellite);
    return renderChunksOf(track).map((chunk) => {
      const visible = shown && chunkOverlaps(chunk, windowStartRelS, windowEndRelS);
      return new TrackLayer({
        id: trackLayerId(track.satellite, chunk.index),
        data: chunk.data,
        _pathType: 'open',
        positionFormat: 'XYZ',
        getColor: colors.get(track.satellite)?.rgb ?? [255, 255, 255],
        getWidth: TRACK_WIDTH_PX,
        widthUnits: 'pixels',
        widthScale: focused ? FOCUSED_WIDTH_SCALE : 1,
        jointRounded: true,
        capRounded: true,
        visible,
        opacity: trackOpacity(focus, focused, pinActive),
        // Hidden chunks get constant uniforms: with no prop change deck.gl skips their update
        // entirely (~90 % of the ~150 chunk layers during a scrub).
        windowStartRelS: visible ? windowStartRelS : 0,
        windowEndRelS: visible ? windowEndRelS : 0,
        fadeFloor: TRAIL_FADE_FLOOR,
        pickable: true,
        autoHighlight: true,
        highlightColor: HIGHLIGHT_RGBA,
        ...placement(beforeId),
      });
    });
  });

  const heads = new ScatterplotLayer<SatelliteHead>({
    id: HEADS_LAYER_ID,
    data: satelliteHeads(input),
    getPosition: (d) => d.position,
    getFillColor: (d) => [...d.color],
    getLineColor: HEAD_OUTLINE_RGB,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    radiusUnits: 'pixels',
    getRadius: HEAD_RADIUS_PX,
    pickable: true,
    // A new (10-item) data array per update: every accessor re-runs, which is negligible here.
    ...placement(beforeId),
  });

  return [...trackLayers, heads, ...passLayers(input)];
}

function trackOpacity(focus: string | null, focused: boolean, pinActive: boolean): number {
  if (focus !== null) return focused ? 1 : DIMMED_OPACITY;
  return pinActive ? TRACKS_WITH_PIN_OPACITY : 1;
}

/** Pass portions, drawn over everything else with a dark halo; hovered/selected ones widen. */
function passLayers({
  passes = [],
  hoveredPassId = null,
  selectedPassId = null,
  beforeId,
  timeWindow,
}: LayerInput): Layer[] {
  if (passes.length === 0) return [];
  const emphasized = (d: PassPath) => d.id === hoveredPassId || d.id === selectedPassId;
  const width = (d: PassPath) => (emphasized(d) ? PASS_EMPHASIS_WIDTH_PX : PASS_WIDTH_PX);
  // Which passes are in the timeline window only changes a few times a minute while playing:
  // key the colour/width updates on that set, not on the window (which moves every frame).
  const inWindowIds = new Set(
    passes.filter((d) => d.endS >= timeWindow.startS && d.startS <= timeWindow.endS).map((d) => d.id),
  );
  const inWindowKey = [...inWindowIds].join(',');
  const strong = (d: PassPath) => emphasized(d) || inWindowIds.has(d.id);
  const alpha = (d: PassPath) => (strong(d) ? OPAQUE : PASS_OUTSIDE_WINDOW_ALPHA);
  const common = {
    data: passes,
    getPath: (d: PassPath) => d.path,
    widthUnits: 'pixels' as const,
    capRounded: true,
    jointRounded: true,
    updateTriggers: {
      getWidth: [hoveredPassId, selectedPassId, inWindowKey],
      getColor: [hoveredPassId, selectedPassId, inWindowKey],
    },
    ...placement(beforeId),
  };
  return [
    new PathLayer<PassPath>({
      ...common,
      id: PASSES_OUTLINE_LAYER_ID,
      getColor: PASS_OUTLINE_RGBA,
      // Faint passes get no halo at all (zero width: nothing rasterized).
      getWidth: (d) => (strong(d) ? width(d) + PASS_OUTLINE_PX : 0),
    }),
    new PathLayer<PassPath>({
      ...common,
      id: PASSES_LAYER_ID,
      getColor: (d) => [...d.color, alpha(d)],
      getWidth: width,
      pickable: true,
    }),
  ];
}

/** The parts of a deck.gl PickingInfo the tooltip needs. */
export interface PickLike {
  layerId: string | undefined;
  index: number;
  coordinate: readonly number[] | undefined;
  object: unknown;
  x: number;
  y: number;
}

export const isPassPath = (o: unknown): o is PassPath =>
  typeof o === 'object' && o !== null && 'id' in o && 'path' in o && typeof o.id === 'string';

const isHead = (o: unknown): o is SatelliteHead =>
  typeof o === 'object' && o !== null && 'satellite' in o && 'timeS' in o && 'position' in o;

/** Resolves what the pointer is over into tooltip content, or null. */
export function hoverFromPick(pick: PickLike, tracks: LoadedTracks, timeWindow: TimeWindow): MapHover | null {
  if (pick.layerId === PASSES_LAYER_ID && isPassPath(pick.object)) {
    return { kind: 'pass', passId: pick.object.id, x: pick.x, y: pick.y };
  }
  if (pick.layerId === HEADS_LAYER_ID && isHead(pick.object)) {
    const [lon, lat] = pick.object.position;
    return {
      kind: 'track',
      satellite: pick.object.satellite,
      timeS: pick.object.timeS,
      lon,
      lat,
      altKm: pick.object.altKm,
      x: pick.x,
      y: pick.y,
    };
  }
  const layer = pick.layerId ? parseTrackLayerId(pick.layerId) : null;
  if (!layer || !pick.coordinate || pick.index < 0) return null;
  const { satellite } = layer;
  const track = tracks.tracks.find((t) => t.satellite === satellite);
  const chunk = track ? renderChunksOf(track).find((c) => c.index === layer.chunk) : undefined;
  const [lon = 0, lat = 0] = pick.coordinate;
  if (!track || !chunk) return null;
  const hit = nearestOnPath(chunk, {
    pathIndex: pick.index,
    lon,
    lat,
    windowRelS: [timeWindow.startS - tracks.t0S, timeWindow.endS - tracks.t0S],
  });
  if (!hit) return null;
  const timeS = tracks.t0S + hit.timeRelS;
  const sample = sampleTrack(track, timeS);
  return sample ? { kind: 'track', satellite, timeS, ...sample, x: pick.x, y: pick.y } : null;
}
