/**
 * App state (Zustand). The map subscribes to slices with `subscribe` and updates deck.gl layer
 * props directly, so scrubbing the timeline or toggling satellites never re-renders React trees
 * beyond the small controls that display the values (CLAUDE.md "Web hot path").
 */
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

import type { CameraState, Projection, UrlState } from './url';

/** What the pointer is over on the map (for the tooltip). Times are epoch seconds. */
export interface TrackHover {
  satellite: string;
  timeS: number;
  lon: number;
  lat: number;
  altKm: number;
  /** Pointer position in map-container pixels. */
  x: number;
  y: number;
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
  hover: TrackHover | null;
  helpOpen: boolean;
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
  setHover: (hover: TrackHover | null) => void;
  setHelpOpen: (open: boolean) => void;
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
};

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
          set({
            bounds,
            satellites,
            hidden: visible ? new Set(satellites.filter((id) => !visible.includes(id))) : new Set(),
            timeWindow: url.timeWindow ? clampWindow(url.timeWindow, bounds) : defaultWindow(bounds),
          });
        },

        toggleSatellite(id) {
          const hidden = new Set(get().hidden);
          if (!hidden.delete(id)) hidden.add(id);
          set({ hidden });
        },
        soloSatellite(id) {
          set({ hidden: new Set(get().satellites.filter((s) => s !== id)) });
        },
        showAllSatellites() {
          set({ hidden: new Set() });
        },
        hideAllSatellites() {
          set({ hidden: new Set(get().satellites) });
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
      };
    }),
  );
}

export const appStore = createAppStore();

/** React binding. Select the smallest slice you need: components re-render only when it changes. */
export const useAppStore = <T>(selector: (s: AppStore) => T): T => useStore(appStore, selector);
