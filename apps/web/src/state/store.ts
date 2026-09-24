/**
 * App state (Zustand). The map subscribes to slices with `subscribe` and updates deck.gl layer
 * props directly, so scrubbing the timeline or toggling satellites never re-renders React trees
 * beyond the small controls that display the values (CLAUDE.md "Web hot path").
 */
import { RADIUS_KM } from '@ow/shared';
import { useStore } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import {
  DEFAULT_SPEED,
  applyPreset,
  advanceWindow,
  clampWindow,
  defaultWindow,
  spanOf,
  type Bounds,
  type Preset,
  type TimeWindow,
} from '../features/timeline/timelineMath';

import { clampDays, passWindow } from '../features/accesses/accessWindow';

import type { CameraState, Projection, UrlState } from './url';

/** A point of a track under the pointer (for the tooltip). Times are epoch seconds. */
export interface TrackHover {
  kind: 'track';
  satellite: string;
  timeS: number;
  lon: number;
  lat: number;
  altKm: number;
  /** Pointer position in map-container pixels. */
  x: number;
  y: number;
}

/** A highlighted pass portion under the pointer on the map. */
export interface PassHover {
  kind: 'pass';
  passId: string;
  x: number;
  y: number;
}

export type MapHover = TrackHover | PassHover;

export interface LonLatPoint {
  lon: number;
  lat: number;
}

/** Parameters of the passes query (the accesses panel). */
export interface AccessParams {
  /** Where the user dropped the pin; null hides the accesses panel's results. */
  pin: LonLatPoint | null;
  radiusKm: number;
  /** Whole UTC days, epoch seconds: [startS, endS) with endS exclusive. */
  startS: number;
  endS: number;
  daylightOnly: boolean;
}

/** A pass as the timeline needs it (epoch seconds). */
export interface PassSpan {
  id: string;
  startS: number;
  endS: number;
}

export interface DatasetMeta {
  bounds: Bounds;
  /** Satellite ids in display order. */
  satellites: readonly string[];
}

export interface AppState {
  /** Dataset span; null until the dataset metadata has loaded. */
  bounds: Bounds | null;
  satellites: readonly string[];
  hidden: ReadonlySet<string>;
  timeWindow: TimeWindow;
  playing: boolean;
  speed: number;
  projection: Projection;
  /** Last camera reported by the map (for shareable links); null before the map moved. */
  camera: CameraState | null;
  /** Satellite under the pointer in the side panel: emphasized on the map. */
  focusedSatellite: string | null;
  hover: MapHover | null;
  helpOpen: boolean;
  access: AccessParams;
  /** Pass under the pointer in the table, on the map or on the timeline (three-way sync). */
  hoveredPassId: string | null;
  /** Pass the user clicked: framed on the timeline, highlighted everywhere. */
  selectedPassId: string | null;
}

export interface AppActions {
  /** Restores the view (projection, camera) from a link: needs no data, so it runs before the first render. */
  restoreView: (url: UrlState) => void;
  /** Applies the dataset and the data-dependent link state (satellites, timeWindow). */
  initialize: (meta: DatasetMeta, url?: UrlState) => void;
  toggleSatellite: (id: string) => void;
  soloSatellite: (id: string) => void;
  showAllSatellites: () => void;
  hideAllSatellites: () => void;
  setWindow: (w: TimeWindow) => void;
  applyPreset: (preset: Preset) => void;
  /** Shifts the window by a fraction of its own span (keyboard nudges). */
  nudgeWindow: (spans: number) => void;
  togglePlaying: () => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  /** Advances playback by `realS` seconds of wall-clock time. */
  tick: (realS: number) => void;
  setProjection: (projection: Projection) => void;
  toggleProjection: () => void;
  setCamera: (camera: CameraState) => void;
  setFocusedSatellite: (id: string | null) => void;
  setHover: (hover: MapHover | null) => void;
  setHelpOpen: (open: boolean) => void;
  setPin: (pin: LonLatPoint | null) => void;
  setRadius: (radiusKm: number) => void;
  /** Sets the query days; snapped to whole UTC days inside the dataset. */
  setAccessDays: (startS: number, endS: number) => void;
  setDaylightOnly: (daylightOnly: boolean) => void;
  setHoveredPass: (id: string | null) => void;
  /** Selects a pass and frames it on the timeline (pausing playback). */
  focusPass: (pass: PassSpan) => void;
}

export type AppStore = AppState & AppActions;

const initialState: AppState = {
  bounds: null,
  satellites: [],
  hidden: new Set(),
  timeWindow: { startS: 0, endS: 0 },
  playing: false,
  speed: DEFAULT_SPEED,
  projection: 'globe',
  camera: null,
  focusedSatellite: null,
  hover: null,
  helpOpen: false,
  access: { pin: null, radiusKm: RADIUS_KM.default, startS: 0, endS: 0, daylightOnly: false },
  hoveredPassId: null,
  selectedPassId: null,
};

/** Hovered/selected pass ids refer to the current result set: reset them when the query changes. */
const NO_PASS_FOCUS = { hoveredPassId: null, selectedPassId: null } as const;

const clampRadius = (km: number): number => Math.min(Math.max(Math.round(km), RADIUS_KM.min), RADIUS_KM.max);

export function createAppStore() {
  return createStore<AppStore>()(
    subscribeWithSelector((set, get) => {
      /** Applies a window change against the loaded bounds (no-op before initialization). */
      const setClampedWindow = (w: TimeWindow): void => {
        const { bounds } = get();
        if (bounds) set({ timeWindow: clampWindow(w, bounds) });
      };

      return {
        ...initialState,

        restoreView(url) {
          set({ projection: url.projection ?? get().projection, camera: url.camera ?? get().camera });
        },

        initialize({ bounds, satellites }, url = {}) {
          const known = new Set(satellites);
          const visible = url.satellites?.filter((id) => known.has(id));
          const days = url.accessDays ?? bounds;
          set({
            access: {
              pin: url.pin ?? null,
              radiusKm: clampRadius(url.radiusKm ?? RADIUS_KM.default),
              ...clampDays(days.startS, days.endS, bounds),
              daylightOnly: url.daylightOnly ?? false,
            },
            bounds,
            satellites,
            hidden: visible ? new Set(satellites.filter((id) => !visible.includes(id))) : new Set(),
            timeWindow: url.timeWindow ? clampWindow(url.timeWindow, bounds) : defaultWindow(bounds),
          });
        },

        toggleSatellite(id) {
          const hidden = new Set(get().hidden);
          if (!hidden.delete(id)) hidden.add(id);
          set({ hidden, ...NO_PASS_FOCUS });
        },
        soloSatellite(id) {
          set({ hidden: new Set(get().satellites.filter((s) => s !== id)), ...NO_PASS_FOCUS });
        },
        showAllSatellites() {
          set({ hidden: new Set(), ...NO_PASS_FOCUS });
        },
        hideAllSatellites() {
          set({ hidden: new Set(get().satellites), ...NO_PASS_FOCUS });
        },

        setWindow: setClampedWindow,
        applyPreset(preset) {
          const { bounds, timeWindow } = get();
          if (bounds) set({ timeWindow: applyPreset(timeWindow, preset, bounds) });
        },
        nudgeWindow(spans) {
          const { timeWindow } = get();
          const deltaS = spanOf(timeWindow) * spans;
          setClampedWindow({ startS: timeWindow.startS + deltaS, endS: timeWindow.endS + deltaS });
        },

        togglePlaying() {
          get().setPlaying(!get().playing);
        },
        setPlaying(playing) {
          const { bounds, timeWindow } = get();
          if (!bounds) return;
          // Pressing play at the end of the data replays from the start.
          if (playing && timeWindow.endS >= bounds.endS) {
            set({
              playing,
              timeWindow: clampWindow(
                { startS: bounds.startS, endS: bounds.startS + spanOf(timeWindow) },
                bounds,
              ),
            });
          } else {
            set({ playing });
          }
        },
        setSpeed(speed) {
          set({ speed });
        },
        tick(realS) {
          const { bounds, timeWindow, speed, playing } = get();
          if (!bounds || !playing) return;
          const next = advanceWindow(timeWindow, realS * speed, bounds);
          set({ timeWindow: next.timeWindow, playing: !next.ended });
        },

        setProjection(projection) {
          set({ projection });
        },
        toggleProjection() {
          set({ projection: get().projection === 'globe' ? 'mercator' : 'globe' });
        },
        setCamera(camera) {
          set({ camera });
        },
        setFocusedSatellite(focusedSatellite) {
          set({ focusedSatellite });
        },
        setHover(hover) {
          set({ hover });
        },
        setHelpOpen(helpOpen) {
          set({ helpOpen });
        },

        setPin(pin) {
          set({ access: { ...get().access, pin }, ...NO_PASS_FOCUS });
        },
        setRadius(radiusKm) {
          set({ access: { ...get().access, radiusKm: clampRadius(radiusKm) }, ...NO_PASS_FOCUS });
        },
        setAccessDays(startS, endS) {
          const { bounds, access } = get();
          if (bounds) set({ access: { ...access, ...clampDays(startS, endS, bounds) }, ...NO_PASS_FOCUS });
        },
        setDaylightOnly(daylightOnly) {
          set({ access: { ...get().access, daylightOnly }, ...NO_PASS_FOCUS });
        },
        setHoveredPass(hoveredPassId) {
          set({ hoveredPassId });
        },
        focusPass({ id, startS, endS }) {
          const { bounds } = get();
          if (!bounds) return;
          set({
            selectedPassId: id,
            playing: false,
            timeWindow: clampWindow(passWindow(startS, endS), bounds),
          });
        },
      };
    }),
  );
}

export const appStore = createAppStore();

/** React binding. Select the smallest slice you need: components re-render only when it changes. */
export const useAppStore = <T>(selector: (s: AppStore) => T): T => useStore(appStore, selector);
