/**
 * Pure time-window math behind the timeline: clamping, dragging, presets, playback and ticks.
 * All times are epoch seconds (UTC).
 */
import { SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from '../../lib/time';

export interface TimeWindow {
  startS: number;
  endS: number;
}

/** The dataset span: every window is kept inside it. */
export type Bounds = TimeWindow;

/** Smallest selectable window: shorter than this and no track segment is visible anyway. */
export const MIN_WINDOW_S = 10 * SECONDS_PER_MINUTE;
/** Dragging snaps to whole minutes: readable labels and shareable URLs. */
export const SNAP_S = SECONDS_PER_MINUTE;

export interface Preset {
  label: string;
  /** Window length; null selects the whole dataset. */
  spanS: number | null;
}

export const PRESETS: readonly Preset[] = [
  { label: '1 h', spanS: SECONDS_PER_HOUR },
  { label: '6 h', spanS: 6 * SECONDS_PER_HOUR },
  { label: '1 d', spanS: SECONDS_PER_DAY },
  { label: 'All', spanS: null },
];

/** First view: ~4 orbits per satellite, readable without the week-long "spaghetti". */
export const DEFAULT_WINDOW_S = 6 * SECONDS_PER_HOUR;

/** Simulated seconds per real second while playing. */
export const SPEEDS: readonly { value: number; label: string }[] = [
  { value: 60, label: '1 min/s' },
  { value: 300, label: '5 min/s' },
  { value: 900, label: '15 min/s' },
  { value: 3600, label: '1 h/s' },
];
export const DEFAULT_SPEED = 900;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export const snap = (tS: number, stepS = SNAP_S): number => Math.round(tS / stepS) * stepS;

export const spanOf = (w: TimeWindow): number => w.endS - w.startS;

/** Smallest span the bounds allow (a dataset shorter than MIN_WINDOW_S is shown whole). */
const minSpan = (b: Bounds): number => Math.min(MIN_WINDOW_S, spanOf(b));

/**
 * Brings a window inside the bounds, keeping its span when possible: a window pushed past an edge
 * slides back instead of shrinking. Spans are limited to [MIN_WINDOW_S, bounds span].
 */
export function clampWindow(w: TimeWindow, b: Bounds): TimeWindow {
  const span = clamp(spanOf(w), minSpan(b), spanOf(b));
  const startS = clamp(w.startS, b.startS, b.endS - span);
  return { startS, endS: startS + span };
}

export const defaultWindow = (b: Bounds): TimeWindow =>
  clampWindow({ startS: b.startS, endS: b.startS + DEFAULT_WINDOW_S }, b);

/** Moves the window so it starts at `startS` (same span). */
export const moveWindowTo = (w: TimeWindow, startS: number, b: Bounds): TimeWindow =>
  clampWindow({ startS, endS: startS + spanOf(w) }, b);

/** Centers the window on `tS` (same span): clicking the timeline jumps there. */
export const centerWindowAt = (w: TimeWindow, tS: number, b: Bounds): TimeWindow =>
  moveWindowTo(w, tS - spanOf(w) / 2, b);

/** Drags one edge to `tS`; the other edge stays put. */
export function resizeWindow(w: TimeWindow, edge: 'start' | 'end', tS: number, b: Bounds): TimeWindow {
  const min = minSpan(b);
  return edge === 'start'
    ? { startS: clamp(tS, b.startS, w.endS - min), endS: w.endS }
    : { startS: w.startS, endS: clamp(tS, w.startS + min, b.endS) };
}

/** Applies a preset keeping the window start (sliding back at the end of the dataset). */
export const applyPreset = (w: TimeWindow, preset: Preset, b: Bounds): TimeWindow =>
  preset.spanS === null ? { ...b } : clampWindow({ startS: w.startS, endS: w.startS + preset.spanS }, b);

export const isPresetActive = (w: TimeWindow, preset: Preset, b: Bounds): boolean =>
  preset.spanS === null
    ? w.startS === b.startS && w.endS === b.endS
    : Math.abs(spanOf(w) - Math.min(preset.spanS, spanOf(b))) < 1;

/** Advances a playing window. `ended` is true once it reaches the end of the dataset. */
export function advanceWindow(
  w: TimeWindow,
  deltaS: number,
  b: Bounds,
): { timeWindow: TimeWindow; ended: boolean } {
  const next = moveWindowTo(w, w.startS + deltaS, b);
  return { timeWindow: next, ended: next.endS >= b.endS };
}

// ---------------------------------------------------------------------------------------------
// Scale and ticks

export const timeToFraction = (tS: number, b: Bounds): number => (tS - b.startS) / spanOf(b);

export const fractionToTime = (f: number, b: Bounds): number => b.startS + clamp(f, 0, 1) * spanOf(b);

/** Minor tick steps, finest first; the first one leaving MIN_TICK_GAP_PX between ticks wins. */
const MINOR_STEPS_S = [1, 3, 6, 12].map((h) => h * SECONDS_PER_HOUR);
const MIN_TICK_GAP_PX = 28;

export interface Ticks {
  /** UTC midnights inside the bounds. */
  days: number[];
  /** Hour ticks (excluding midnights) at a step that stays readable for the given width. */
  hours: number[];
  hourStepS: number;
}

export function timeTicks(b: Bounds, widthPx: number): Ticks {
  const span = spanOf(b);
  const pxPerS = span > 0 ? widthPx / span : 0;
  const hourStepS = MINOR_STEPS_S.find((step) => step * pxPerS >= MIN_TICK_GAP_PX) ?? SECONDS_PER_DAY;
  const days: number[] = [];
  const hours: number[] = [];
  // Every step divides a day, so stepping from an aligned start lands on each UTC midnight.
  for (let t = Math.ceil(b.startS / hourStepS) * hourStepS; t <= b.endS; t += hourStepS) {
    (t % SECONDS_PER_DAY === 0 ? days : hours).push(t);
  }
  return { days, hours, hourStepS };
}
