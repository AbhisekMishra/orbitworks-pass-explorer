/**
 * Timeline: the time filter for the map. A draggable window over the dataset span (drag the body
 * to move it, the handles to resize it, click anywhere to jump), exact UTC inputs, presets and
 * playback. Every change goes to the store; the map applies it as GPU uniforms (no refetch).
 */
import type { Pass } from '@ow/shared';
import {
  memo,
  useMemo,
  useRef,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { PauseIcon, PlayIcon } from '../../components/icons';
import { useElementWidth } from '../../lib/useElementWidth';
import {
  SECONDS_PER_DAY,
  formatDateTime,
  formatDay,
  formatDuration,
  formatHour,
  fromDateTimeInput,
  toDateTimeInput,
  toEpochS,
} from '../../lib/time';
import type { SatelliteColor } from '../../map/colors';
import { useAppStore } from '../../state/store';

import styles from './Timeline.module.css';
import {
  PRESETS,
  SPEEDS,
  centerWindowAt,
  fractionToTime,
  isPresetActive,
  moveWindowTo,
  resizeWindow,
  snap,
  spanOf,
  timeTicks,
  timeToFraction,
  type Bounds,
  type TimeWindow,
} from './timelineMath';
import { usePlayback } from './usePlayback';

const NO_PASSES: readonly Pass[] = [];

interface TimelineProps {
  colors: ReadonlyMap<string, SatelliteColor>;
  /** Passes of the accesses query: marked on the timeline, in sync with the table and the map. */
  passes?: readonly Pass[];
}

/** Memoized: App re-renders while the accesses controls move; the timeline need not. */
export const Timeline = memo(function Timeline({ colors, passes = NO_PASSES }: Readonly<TimelineProps>) {
  const bounds = useAppStore((s) => s.bounds);
  usePlayback();
  return (
    <footer className={styles.timeline} aria-label="Timeline">
      {bounds ? (
        <TimelineBody bounds={bounds} colors={colors} passes={passes} />
      ) : (
        <div className={styles.placeholder} aria-busy="true" />
      )}
    </footer>
  );
});

function TimelineBody({
  bounds,
  colors,
  passes,
}: Readonly<{ bounds: Bounds; colors: ReadonlyMap<string, SatelliteColor>; passes: readonly Pass[] }>) {
  const timeWindow = useAppStore((s) => s.timeWindow);
  return (
    <>
      <div className={styles.controls}>
        <PlayControls />
        <RangeInputs bounds={bounds} timeWindow={timeWindow} />
        <Presets bounds={bounds} timeWindow={timeWindow} />
      </div>
      <TimeTrack bounds={bounds} timeWindow={timeWindow}>
        <PassTicks bounds={bounds} passes={passes} colors={colors} />
      </TimeTrack>
    </>
  );
}

/** Memoized: it depends on the store only, not on the window that changes every frame. */
const PlayControls = memo(function PlayControls() {
  const playing = useAppStore((s) => s.playing);
  const speed = useAppStore((s) => s.speed);
  const togglePlaying = useAppStore((s) => s.togglePlaying);
  const setSpeed = useAppStore((s) => s.setSpeed);
  return (
    <div className={styles.play}>
      <button
        type="button"
        className={styles.playButton}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause (Space)' : 'Play: slide the window forward in time (Space)'}
        onClick={togglePlaying}
      >
        {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
      </button>
      <select
        className={styles.speed}
        aria-label="Playback speed"
        title="Playback speed (simulated time per second)"
        value={speed}
        onChange={(e) => {
          setSpeed(Number(e.target.value));
        }}
      >
        {SPEEDS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
});

function RangeInputs({ bounds, timeWindow }: Readonly<{ bounds: Bounds; timeWindow: TimeWindow }>) {
  const setWindow = useAppStore((s) => s.setWindow);
  const edit = (edge: 'start' | 'end', e: ChangeEvent<HTMLInputElement>) => {
    const t = fromDateTimeInput(e.target.value);
    if (t !== null) setWindow(resizeWindow(timeWindow, edge, t, bounds));
  };
  const [min, max] = useMemo(() => [toDateTimeInput(bounds.startS), toDateTimeInput(bounds.endS)], [bounds]);
  return (
    <div className={styles.range}>
      <label className={styles.field}>
        <span>From</span>
        <input
          type="datetime-local"
          step={60}
          min={min}
          max={max}
          value={toDateTimeInput(timeWindow.startS)}
          onChange={(e) => {
            edit('start', e);
          }}
          aria-label="Window start (UTC)"
        />
      </label>
      <span className={styles.arrow} aria-hidden="true">
        →
      </span>
      <label className={styles.field}>
        <span>To</span>
        <input
          type="datetime-local"
          step={60}
          min={min}
          max={max}
          value={toDateTimeInput(timeWindow.endS)}
          onChange={(e) => {
            edit('end', e);
          }}
          aria-label="Window end (UTC)"
        />
      </label>
      <span className={styles.duration} data-testid="window-duration" title="Length of the visible window">
        {formatDuration(spanOf(timeWindow))}
      </span>
    </div>
  );
}

function Presets({ bounds, timeWindow }: Readonly<{ bounds: Bounds; timeWindow: TimeWindow }>) {
  const applyPreset = useAppStore((s) => s.applyPreset);
  return (
    <div className={styles.presets} role="group" aria-label="Window length">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          className={styles.preset}
          aria-pressed={isPresetActive(timeWindow, p, bounds)}
          title={p.spanS === null ? 'Show the whole week' : `Show ${p.label} from the current start`}
          onClick={() => {
            applyPreset(p);
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

type DragMode = 'move' | 'start' | 'end';
interface Drag {
  mode: DragMode;
  /** Time under the pointer when the drag began, and the window at that moment. */
  pointerS: number;
  origin: TimeWindow;
}

function TimeTrack({
  bounds,
  timeWindow,
  children,
}: Readonly<{ bounds: Bounds; timeWindow: TimeWindow; children?: React.ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const width = useElementWidth(ref);
  const setWindow = useAppStore((s) => s.setWindow);
  const setPlaying = useAppStore((s) => s.setPlaying);

  const timeAt = (clientX: number): number => {
    const r = ref.current?.getBoundingClientRect();
    return r && r.width > 0 ? fractionToTime((clientX - r.left) / r.width, bounds) : bounds.startS;
  };

  const begin = (mode: DragMode | 'jump', e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    ref.current?.setPointerCapture(e.pointerId);
    setPlaying(false);
    const pointerS = timeAt(e.clientX);
    let origin = timeWindow;
    if (mode === 'jump') {
      origin = centerWindowAt(timeWindow, snap(pointerS), bounds);
      setWindow(origin);
    }
    drag.current = { mode: mode === 'jump' ? 'move' : mode, pointerS, origin };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    setWindow(
      d.mode === 'move'
        ? moveWindowTo(d.origin, snap(d.origin.startS + t - d.pointerS), bounds)
        : resizeWindow(d.origin, d.mode, snap(t), bounds),
    );
  };

  const end = (e: ReactPointerEvent) => {
    drag.current = null;
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
  };

  const left = timeToFraction(timeWindow.startS, bounds) * 100;
  const size = (spanOf(timeWindow) / spanOf(bounds)) * 100;

  return (
    <div
      ref={ref}
      className={styles.track}
      data-testid="timeline-track"
      title="Click to jump · drag the window to scrub"
      onPointerDown={(e) => {
        begin('jump', e);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <TickMarks bounds={bounds} width={width} />
      {children}
      <div
        className={styles.timeWindow}
        data-testid="timeline-window"
        style={{ left: `${left}%`, width: `${size}%` }}
        role="slider"
        tabIndex={0}
        aria-label="Visible time window (arrow keys move it)"
        aria-valuemin={bounds.startS}
        aria-valuemax={bounds.endS}
        aria-valuenow={timeWindow.startS}
        aria-valuetext={`${formatDateTime(timeWindow.startS)} to ${formatDateTime(timeWindow.endS)} UTC`}
        onPointerDown={(e) => {
          begin('move', e);
        }}
      >
        <div
          className={styles.handle}
          data-edge="start"
          data-testid="timeline-handle-start"
          title="Drag to change the start"
          onPointerDown={(e) => {
            begin('start', e);
          }}
        />
        <div
          className={styles.handle}
          data-edge="end"
          data-testid="timeline-handle-end"
          title="Drag to change the end"
          onPointerDown={(e) => {
            begin('end', e);
          }}
        />
      </div>
    </div>
  );
}

/** Day and hour ticks. Memoized: they only change with the bounds or the width, never per frame. */
const TickMarks = memo(function TickMarks({ bounds, width }: Readonly<{ bounds: Bounds; width: number }>) {
  const { days, hours, hourStepS } = timeTicks(bounds, width);
  const at = (t: number) => ({ left: `${timeToFraction(t, bounds) * 100}%` });
  return (
    <div className={styles.ticks} aria-hidden="true">
      {days.map((t) => (
        <div key={t} className={styles.dayTick} style={at(t)}>
          <span>{formatDay(t)}</span>
        </div>
      ))}
      {hourStepS < SECONDS_PER_DAY &&
        hours.map((t) => (
          <div key={t} className={styles.hourTick} style={at(t)}>
            <span>{formatHour(t)}</span>
          </div>
        ))}
    </div>
  );
});

/**
 * One mark per pass at its start time. Hovering one highlights the same pass in the table and on
 * the map; clicking frames it. Pointer-down is stopped so marks never start a window drag.
 */
const PassTicks = memo(function PassTicks({
  bounds,
  passes,
  colors,
}: Readonly<{ bounds: Bounds; passes: readonly Pass[]; colors: ReadonlyMap<string, SatelliteColor> }>) {
  // Parsed once per pass list, not on every hover.
  const marks = useMemo(
    () =>
      passes.map((pass) => {
        const startS = toEpochS(pass.start);
        return { pass, startS, endS: toEpochS(pass.end), left: timeToFraction(startS, bounds) * 100 };
      }),
    [passes, bounds],
  );
  if (marks.length === 0) return null;
  return (
    <div className={styles.passTicks} data-testid="timeline-passes">
      {marks.map((m) => (
        <PassTick key={m.pass.id} {...m} color={colors.get(m.pass.satellite)?.hex} />
      ))}
    </div>
  );
});

/** Memoized with boolean selectors: a hover change re-renders the two marks that flip, only. */
const PassTick = memo(function PassTick({
  pass,
  startS,
  endS,
  left,
  color,
}: Readonly<{ pass: Pass; startS: number; endS: number; left: number; color: string | undefined }>) {
  const hovered = useAppStore((s) => s.hoveredPassId === pass.id);
  const selected = useAppStore((s) => s.selectedPassId === pass.id);
  const setHoveredPass = useAppStore((s) => s.setHoveredPass);
  const focusPass = useAppStore((s) => s.focusPass);
  return (
    <button
      type="button"
      className={styles.passTick}
      style={{ left: `${left}%`, '--sat-color': color } as CSSProperties}
      data-pass-id={pass.id}
      data-hovered={hovered}
      aria-pressed={selected}
      aria-label={`${pass.satellite} pass at ${pass.start.slice(11, 16)} UTC on ${pass.start.slice(0, 10)}`}
      title={`${pass.satellite} · ${pass.start.slice(0, 10)} ${pass.start.slice(11, 19)} UTC`}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      onMouseEnter={() => {
        setHoveredPass(pass.id);
      }}
      onMouseLeave={() => {
        setHoveredPass(null);
      }}
      onClick={() => {
        focusPass({ id: pass.id, startS, endS });
      }}
    />
  );
});
