import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_WINDOW_S, MIN_WINDOW_S, PRESETS } from '../features/timeline/timelineMath';

import { createAppStore } from './store';

const T0 = Date.UTC(2027, 2, 1) / 1000;
const H = 3600;
const WEEK = { startS: T0, endS: T0 + 7 * 24 * H };
const SATS = ['YAM20', 'YAM21', 'YAM22'];

let store: ReturnType<typeof createAppStore>;
const s = () => store.getState();

beforeEach(() => {
  store = createAppStore();
  s().initialize({ bounds: WEEK, satellites: SATS });
});

describe('initialize', () => {
  it('shows every satellite and a default window at the start of the data', () => {
    expect(s().hidden.size).toBe(0);
    expect(s().timeWindow).toEqual({ startS: T0, endS: T0 + DEFAULT_WINDOW_S });
    expect(s().projection).toBe('globe');
  });

  it('applies link state, ignoring unknown satellites and clamping the window', () => {
    s().initialize(
      { bounds: WEEK, satellites: SATS },
      { satellites: ['YAM21', 'GHOST'], timeWindow: { startS: T0 - H, endS: T0 + H } },
    );
    expect([...s().hidden]).toEqual(['YAM20', 'YAM22']);
    expect(s().timeWindow).toEqual({ startS: T0, endS: T0 + 2 * H });
  });

  it('restores the view from a link before any data is loaded, keeping defaults for gaps', () => {
    const fresh = createAppStore();
    fresh.getState().restoreView({ projection: 'mercator', camera: { lat: 1, lon: 2, zoom: 3 } });
    expect(fresh.getState()).toMatchObject({ projection: 'mercator', camera: { lat: 1, lon: 2, zoom: 3 } });
    fresh.getState().restoreView({});
    expect(fresh.getState()).toMatchObject({ projection: 'mercator', camera: { lat: 1, lon: 2, zoom: 3 } });
  });
});

describe('satellite visibility', () => {
  it('toggles, solos, shows and hides all', () => {
    s().toggleSatellite('YAM21');
    expect([...s().hidden]).toEqual(['YAM21']);
    s().toggleSatellite('YAM21');
    expect(s().hidden.size).toBe(0);
    s().soloSatellite('YAM22');
    expect([...s().hidden]).toEqual(['YAM20', 'YAM21']);
    s().hideAllSatellites();
    expect(s().hidden.size).toBe(3);
    s().showAllSatellites();
    expect(s().hidden.size).toBe(0);
  });
});

describe('time window', () => {
  it('clamps windows set by the UI', () => {
    s().setWindow({ startS: T0 - 5 * H, endS: T0 + H });
    expect(s().timeWindow).toEqual({ startS: T0, endS: T0 + 6 * H });
    s().setWindow({ startS: T0, endS: T0 + 1 });
    expect(s().timeWindow.endS - s().timeWindow.startS).toBe(MIN_WINDOW_S);
  });

  it('applies presets and nudges by a fraction of the span', () => {
    s().applyPreset(PRESETS.find((p) => p.label === '1 h')!);
    expect(s().timeWindow).toEqual({ startS: T0, endS: T0 + H });
    s().nudgeWindow(0.5);
    expect(s().timeWindow).toEqual({ startS: T0 + H / 2, endS: T0 + 1.5 * H });
    s().nudgeWindow(-10);
    expect(s().timeWindow.startS).toBe(T0);
  });

  it('ignores window changes before the dataset is known', () => {
    const fresh = createAppStore();
    fresh.getState().setWindow({ startS: 1, endS: 2 });
    fresh.getState().applyPreset(PRESETS[0]!);
    fresh.getState().setPlaying(true);
    fresh.getState().tick(1);
    expect(fresh.getState().timeWindow).toEqual({ startS: 0, endS: 0 });
    expect(fresh.getState().playing).toBe(false);
  });
});

describe('playback', () => {
  it('advances the window by wall-clock time × speed', () => {
    s().setSpeed(600);
    s().tick(1); // not playing: no-op
    expect(s().timeWindow.startS).toBe(T0);
    s().togglePlaying();
    s().tick(0.5);
    expect(s().timeWindow).toEqual({ startS: T0 + 300, endS: T0 + DEFAULT_WINDOW_S + 300 });
  });

  it('stops at the end of the data, and replays from the start when played again', () => {
    s().setWindow({ startS: WEEK.endS - 2 * H, endS: WEEK.endS - H });
    s().setPlaying(true);
    s().tick(3600);
    expect(s().playing).toBe(false);
    expect(s().timeWindow.endS).toBe(WEEK.endS);
    s().togglePlaying();
    expect(s().playing).toBe(true);
    expect(s().timeWindow).toEqual({ startS: T0, endS: T0 + H });
  });
});

describe('view and UI state', () => {
  it('toggles the projection and stores camera, focus, hover and help state', () => {
    s().toggleProjection();
    expect(s().projection).toBe('mercator');
    s().setProjection('globe');
    expect(s().projection).toBe('globe');
    s().setCamera({ lat: 10, lon: 20, zoom: 2 });
    s().setFocusedSatellite('YAM20');
    const hover = {
      kind: 'track' as const,
      satellite: 'YAM20',
      timeS: T0,
      lon: 0,
      lat: 0,
      altKm: 500,
      x: 1,
      y: 2,
    };
    s().setHover(hover);
    s().setHelpOpen(true);
    expect(s()).toMatchObject({
      camera: { lat: 10, lon: 20, zoom: 2 },
      focusedSatellite: 'YAM20',
      hover,
      helpOpen: true,
    });
  });
});

describe('accesses', () => {
  const DAY = 86_400;

  it('defaults to the whole dataset, 400 km, no pin', () => {
    expect(s().access).toEqual({
      pin: null,
      radiusKm: 400,
      startS: WEEK.startS,
      endS: WEEK.endS,
      daylightOnly: false,
    });
  });

  it('restores link state, clamping radius and days', () => {
    s().initialize(
      { bounds: WEEK, satellites: SATS },
      {
        pin: { lat: 1, lon: 2 },
        radiusKm: 5000,
        accessDays: { startS: T0 - DAY, endS: T0 + 2 * DAY },
        daylightOnly: true,
      },
    );
    expect(s().access).toEqual({
      pin: { lat: 1, lon: 2 },
      radiusKm: 2500,
      startS: T0,
      endS: T0 + 2 * DAY,
      daylightOnly: true,
    });
  });

  it('sets the pin (clearing pass selection), radius, days and the daylight filter', () => {
    s().setHoveredPass('p1');
    s().focusPass({ id: 'p1', startS: T0 + DAY, endS: T0 + DAY + 100 });
    s().setPin({ lat: 10, lon: 20 });
    expect(s()).toMatchObject({
      access: { pin: { lat: 10, lon: 20 } },
      hoveredPassId: null,
      selectedPassId: null,
    });
    s().setRadius(3.7);
    expect(s().access.radiusKm).toBe(10);
    s().setAccessDays(T0 + 2 * DAY + 5, T0 + 3 * DAY);
    expect(s().access).toMatchObject({ startS: T0 + 2 * DAY, endS: T0 + 3 * DAY });
    s().setDaylightOnly(true);
    expect(s().access.daylightOnly).toBe(true);
    s().setPin(null);
    expect(s().access.pin).toBeNull();
  });

  it('focuses a pass: selects it and frames it on the timeline, pausing playback', () => {
    s().setPlaying(true);
    s().focusPass({ id: 'p1', startS: T0 + DAY, endS: T0 + DAY + 100 });
    expect(s()).toMatchObject({
      selectedPassId: 'p1',
      playing: false,
      timeWindow: { startS: T0 + DAY - 600, endS: T0 + DAY + 700 },
    });
  });

  it('ignores day and focus changes before the dataset is known', () => {
    const fresh = createAppStore();
    fresh.getState().setAccessDays(1, 2);
    fresh.getState().focusPass({ id: 'x', startS: 1, endS: 2 });
    expect(fresh.getState()).toMatchObject({ selectedPassId: null, access: { startS: 0, endS: 0 } });
  });
});
