/**
 * Accesses: when do the selected satellites pass over a place? Drop a pin on the map, pick a
 * radius, days and (optionally) daylight only; passes are listed by day and highlighted on the map
 * and the timeline. Hovering a row, a map portion or a timeline tick highlights the other two.
 */
import type { AccessesResponse, Pass } from '@ow/shared';
import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';

import { CloseIcon, DownloadIcon, MoonIcon, PinIcon, RetryIcon, SunIcon } from '../../components/icons';
import { downloadText } from '../../lib/download';
import { formatLat, formatLon } from '../../lib/format';
import {
  SECONDS_PER_DAY,
  formatDate,
  formatDay,
  formatDuration,
  formatPassDuration,
  parseUtcDay,
  toEpochS,
} from '../../lib/time';
import type { SatelliteColor } from '../../map/colors';
import { appStore, useAppStore, type LonLatPoint } from '../../state/store';

import {
  RADIUS_SLIDER_STEPS,
  csvFileName,
  edgeElevationDeg,
  groupPassesByDay,
  passesToCsv,
  radiusToSlider,
  sliderToRadius,
} from './accessMath';
import styles from './AccessPanel.module.css';
import type { Accesses } from './useAccesses';

/** Altitude used to express the radius as an elevation angle (the fleet flies at 490–542 km). */
const NOMINAL_ALTITUDE_KM = 500;

interface Props {
  colors: ReadonlyMap<string, SatelliteColor>;
  /** The accesses query state, owned by App (one owner for map, table and timeline). */
  accesses: Accesses;
}

export function AccessPanel({ colors, accesses }: Readonly<Props>) {
  const pin = useAppStore((s) => s.access.pin);
  return pin ? <PassFinder pin={pin} colors={colors} accesses={accesses} /> : <PinPrompt />;
}

function PinPrompt() {
  return (
    <aside className={styles.prompt} aria-label="Passes" data-testid="access-prompt">
      <PinIcon size={20} className={styles.promptIcon} />
      <div>
        <p className={styles.promptTitle}>When do satellites pass over a place?</p>
        <p className={styles.promptText}>Click anywhere on the map to drop a pin.</p>
      </div>
    </aside>
  );
}

function PassFinder({
  pin,
  colors,
  accesses,
}: Readonly<{ pin: LonLatPoint; colors: ReadonlyMap<string, SatelliteColor>; accesses: Accesses }>) {
  const setPin = useAppStore((s) => s.setPin);
  const { query, result: data } = accesses;

  return (
    <aside className={styles.panel} aria-label="Passes" data-testid="access-panel">
      <header className={styles.header}>
        <PinIcon size={16} className={styles.headerIcon} />
        <div className={styles.headerText}>
          <h2>Passes over</h2>
          <p data-testid="access-pin">
            {formatLat(pin.lat)}, {formatLon(pin.lon)}
          </p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Download passes as CSV"
          title="Download these passes as CSV"
          // Not while the previous query's result is still shown (placeholder): it would be stale.
          disabled={!data || data.passes.length === 0 || query.isPlaceholderData}
          onClick={() => {
            if (data)
              downloadText(csvFileName(data.query), passesToCsv(data.passes), 'text/csv;charset=utf-8');
          }}
        >
          <DownloadIcon size={16} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Remove the pin"
          title="Remove the pin (Esc)"
          onClick={() => {
            setPin(null);
          }}
        >
          <CloseIcon size={16} />
        </button>
      </header>

      <AccessControls />

      {query.isFetching && (
        <div className={styles.progress} role="progressbar" aria-label="Updating passes" />
      )}

      <ResultsBody accesses={accesses} colors={colors} />
    </aside>
  );
}

function ResultsBody({
  accesses: { wanted, query, result },
  colors,
}: Readonly<{ accesses: Accesses; colors: ReadonlyMap<string, SatelliteColor> }>) {
  if (!wanted) {
    return <p className={styles.notice}>Select at least one satellite in the panel on the left.</p>;
  }
  if (query.isError) {
    return (
      <div className={styles.error} role="alert">
        <p>{query.error.message}</p>
        <button type="button" onClick={() => void query.refetch()}>
          <RetryIcon size={14} /> Retry
        </button>
      </div>
    );
  }
  if (!result) {
    return (
      <p className={styles.notice} role="status">
        Finding passes…
      </p>
    );
  }
  return <AccessResults data={result} colors={colors} stale={query.isPlaceholderData} />;
}

function AccessControls() {
  const access = useAppStore((s) => s.access);
  const bounds = useAppStore((s) => s.bounds);
  const hidden = useAppStore((s) => s.hidden);
  const total = useAppStore((s) => s.satellites.length);
  const setRadius = useAppStore((s) => s.setRadius);
  const setAccessDays = useAppStore((s) => s.setAccessDays);
  const setDaylightOnly = useAppStore((s) => s.setDaylightOnly);

  const minDay = bounds ? formatDate(bounds.startS) : undefined;
  const maxDay = bounds ? formatDate(bounds.endS - 1) : undefined;
  const lastDayS = access.endS - SECONDS_PER_DAY;
  const elevation = edgeElevationDeg(access.radiusKm, NOMINAL_ALTITUDE_KM);

  return (
    <div className={styles.controls}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Radius <strong data-testid="access-radius">{access.radiusKm.toLocaleString('en-US')} km</strong>
        </span>
        <input
          type="range"
          min={0}
          max={RADIUS_SLIDER_STEPS}
          value={radiusToSlider(access.radiusKm)}
          aria-label="Radius"
          aria-valuetext={`${access.radiusKm} km`}
          onChange={(e) => {
            setRadius(sliderToRadius(Number(e.target.value)));
          }}
        />
        <span className={styles.hint}>
          {elevation > 0
            ? `At the edge a ${NOMINAL_ALTITUDE_KM} km-high satellite is ${Math.round(elevation)}° above the horizon.`
            : 'At the edge the satellites are at the horizon.'}
        </span>
      </label>

      <div className={styles.days}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>From (UTC)</span>
          <input
            type="date"
            min={minDay}
            max={maxDay}
            value={formatDate(access.startS)}
            aria-label="First day (UTC)"
            onChange={(e) => {
              const t = parseUtcDay(e.target.value);
              if (t !== null) setAccessDays(t, Math.max(access.endS, t + SECONDS_PER_DAY));
            }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>To (UTC)</span>
          <input
            type="date"
            min={minDay}
            max={maxDay}
            value={formatDate(lastDayS)}
            aria-label="Last day (UTC)"
            onChange={(e) => {
              const t = parseUtcDay(e.target.value);
              if (t !== null) setAccessDays(Math.min(access.startS, t), t + SECONDS_PER_DAY);
            }}
          />
        </label>
      </div>

      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={access.daylightOnly}
          onChange={(e) => {
            setDaylightOnly(e.target.checked);
          }}
        />
        <span className={styles.switch} aria-hidden="true" />
        <span>
          Daylight passes only <span className={styles.hint}>(Sun above the horizon at the pin)</span>
        </span>
      </label>

      <p className={styles.scope}>
        {total - hidden.size} of {total} satellites · filter them in the panel on the left
      </p>
    </div>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AccessResults({
  data,
  colors,
  stale,
}: Readonly<{ data: AccessesResponse; colors: ReadonlyMap<string, SatelliteColor>; stale: boolean }>) {
  const setHoveredPass = useAppStore((s) => s.setHoveredPass);
  const listRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const groups = useMemo(() => groupPassesByDay(data.passes), [data.passes]);
  const { stats } = data;

  // Highlighted from the map or the timeline: bring the row into view. A store subscription, not
  // a selector: the list itself never re-renders on hover (only the two affected rows do).
  useEffect(
    () =>
      appStore.subscribe(
        (s) => s.hoveredPassId,
        (id) => {
          if (!id || pointerInside.current) return;
          listRef.current
            ?.querySelector(`[data-pass-id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        },
      ),
    [],
  );

  return (
    <>
      <dl className={styles.stats} data-testid="access-stats">
        <Stat label="Passes" value={String(stats.passCount)} />
        <Stat label="Total" value={formatDuration(stats.totalDurationS)} />
        <Stat
          label="Every"
          value={stats.meanRevisitS === null ? '—' : `~${formatDuration(stats.meanRevisitS)}`}
        />
        <Stat label="Longest gap" value={stats.maxGapS === null ? '—' : formatDuration(stats.maxGapS)} />
      </dl>

      {groups.length === 0 ? (
        <p className={styles.notice} data-testid="access-empty">
          No passes in this period. Try a larger radius or more days
          {data.query.daylightOnly ? ', or include night passes' : ''}.
        </p>
      ) : (
        <div
          ref={listRef}
          className={styles.list}
          data-stale={stale}
          onPointerEnter={() => {
            pointerInside.current = true;
          }}
          onPointerLeave={() => {
            pointerInside.current = false;
            setHoveredPass(null);
          }}
        >
          <div className={styles.columns} aria-hidden="true">
            <span>Start (UTC)</span>
            <span>Satellite</span>
            <span>Duration</span>
            <span title="Highest elevation above the horizon during the pass">Max elev.</span>
          </div>
          {groups.map((group) => (
            <section key={group.day} className={styles.day} aria-label={group.day}>
              <h3>
                {formatDay(toEpochS(`${group.day}T00:00:00Z`))}
                <span>
                  {group.passes.length} pass{group.passes.length === 1 ? '' : 'es'}
                </span>
              </h3>
              <ol>
                {group.passes.map((pass) => (
                  <PassRow key={pass.id} pass={pass} color={colors.get(pass.satellite)?.hex} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One pass. Memoized with boolean selectors: a hover change re-renders the two rows whose state
 * flips, not the whole list (up to ~300 rows at 2,500 km over a week).
 */
const PassRow = memo(function PassRow({ pass, color }: Readonly<{ pass: Pass; color: string | undefined }>) {
  const hovered = useAppStore((s) => s.hoveredPassId === pass.id);
  const selected = useAppStore((s) => s.selectedPassId === pass.id);
  const setHoveredPass = useAppStore((s) => s.setHoveredPass);
  const focusPass = useAppStore((s) => s.focusPass);
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-pass-id={pass.id}
        data-hovered={hovered}
        aria-pressed={selected}
        style={{ '--sat-color': color } as CSSProperties}
        title={`${pass.satellite}: ${pass.start.slice(11, 19)}–${pass.end.slice(11, 19)} UTC, closest ${pass.minDistanceKm} km, local solar time ${pass.localSolarTimeH.toFixed(1)} h. Click to show it on the timeline.`}
        onMouseEnter={() => {
          setHoveredPass(pass.id);
        }}
        onFocus={() => {
          setHoveredPass(pass.id);
        }}
        onClick={() => {
          focusPass({ id: pass.id, startS: toEpochS(pass.start), endS: toEpochS(pass.end) });
        }}
      >
        <span className={styles.time}>{pass.start.slice(11, 19)}</span>
        <span className={styles.sat}>
          <span className={styles.swatch} />
          {pass.satellite}
        </span>
        <span>{formatPassDuration(pass.durationS)}</span>
        <span className={styles.elev}>
          {Math.round(pass.maxElevationDeg)}°
          {pass.daylight ? (
            <SunIcon size={13} className={styles.sunIcon} aria-label="daylight" />
          ) : (
            <MoonIcon size={13} className={styles.moonIcon} aria-label="night" />
          )}
        </span>
      </button>
    </li>
  );
});
