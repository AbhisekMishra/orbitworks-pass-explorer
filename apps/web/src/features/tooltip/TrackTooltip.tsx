import {
  DAYLIGHT_SUN_ELEVATION_DEG,
  MS_PER_SECOND,
  meanLocalSolarTimeH,
  sunElevationDeg,
  type Pass,
} from '@ow/shared';
import type { CSSProperties } from 'react';

import { MoonIcon, SunIcon } from '../../components/icons';
import { formatLat, formatLon } from '../../lib/format';
import { formatDate, formatHours, formatPassDuration, formatTime } from '../../lib/time';
import type { SatelliteColor } from '../../map/colors';
import { useAppStore, type PassHover, type TrackHover } from '../../state/store';

import styles from './TrackTooltip.module.css';

interface Props {
  colors: ReadonlyMap<string, SatelliteColor>;
  /** Passes of the accesses query, to describe a hovered pass portion. */
  passes?: readonly Pass[];
}

/** Pointer offset, and the width past which the tooltip flips to the left of the pointer. */
const OFFSET_PX = 14;
const FLIP_MARGIN_PX = 280;

function positionStyle(x: number, y: number, color: string | undefined): CSSProperties {
  const flip = x > globalThis.innerWidth - FLIP_MARGIN_PX;
  const dx = flip ? `calc(-100% - ${OFFSET_PX}px)` : `${OFFSET_PX}px`;
  return {
    left: x,
    top: y,
    transform: `translate(${dx}, ${OFFSET_PX}px)`,
    '--sat-color': color,
  } as CSSProperties;
}

function Daylight({ day, sunDeg }: Readonly<{ day: boolean; sunDeg: number }>) {
  return (
    <dd className={day ? styles.day : styles.night}>
      {day ? <SunIcon size={12} /> : <MoonIcon size={12} />}
      {day ? 'Sunlit' : 'Dark'} (Sun {sunDeg.toFixed(0)}°)
    </dd>
  );
}

/**
 * What is under the pointer on the map: a point of a track (which satellite, exactly when it was
 * there, and whether the ground below was sunlit, which matters for optical imaging) or a
 * highlighted pass.
 */
export function TrackTooltip({ colors, passes = [] }: Readonly<Props>) {
  const hover = useAppStore((s) => s.hover);
  if (hover?.kind === 'track') return <TrackPoint hover={hover} colors={colors} />;
  const pass = hover?.kind === 'pass' ? passes.find((p) => p.id === hover.passId) : undefined;
  return hover?.kind === 'pass' && pass ? <PassSummary hover={hover} pass={pass} colors={colors} /> : null;
}

function TrackPoint({
  hover,
  colors,
}: Readonly<{ hover: TrackHover; colors: ReadonlyMap<string, SatelliteColor> }>) {
  const ms = hover.timeS * MS_PER_SECOND;
  const sunDeg = sunElevationDeg(ms, hover.lon, hover.lat);
  return (
    <div
      className={styles.tooltip}
      style={positionStyle(hover.x, hover.y, colors.get(hover.satellite)?.hex)}
      role="tooltip"
      data-testid="track-tooltip"
    >
      <div className={styles.header}>
        <span className={styles.swatch} aria-hidden="true" />
        <strong>{hover.satellite}</strong>
        <span className={styles.time}>{formatTime(hover.timeS)} UTC</span>
      </div>
      <dl className={styles.facts}>
        <dt>Date</dt>
        <dd>{formatDate(hover.timeS)}</dd>
        <dt>Position</dt>
        <dd>
          {formatLat(hover.lat)}, {formatLon(hover.lon)}
        </dd>
        <dt>Altitude</dt>
        <dd>{hover.altKm.toFixed(1)} km</dd>
        <dt>Local solar time</dt>
        <dd>{formatHours(meanLocalSolarTimeH(ms, hover.lon))}</dd>
        <dt>Ground below</dt>
        <Daylight day={sunDeg > DAYLIGHT_SUN_ELEVATION_DEG} sunDeg={sunDeg} />
      </dl>
    </div>
  );
}

function PassSummary({
  hover,
  pass,
  colors,
}: Readonly<{ hover: PassHover; pass: Pass; colors: ReadonlyMap<string, SatelliteColor> }>) {
  return (
    <div
      className={styles.tooltip}
      style={positionStyle(hover.x, hover.y, colors.get(pass.satellite)?.hex)}
      role="tooltip"
      data-testid="pass-tooltip"
    >
      <div className={styles.header}>
        <span className={styles.swatch} aria-hidden="true" />
        <strong>{pass.satellite} pass</strong>
        <span className={styles.time}>
          {pass.start.slice(11, 19)}–{pass.end.slice(11, 19)} UTC
        </span>
      </div>
      <dl className={styles.facts}>
        <dt>Date</dt>
        <dd>{pass.start.slice(0, 10)}</dd>
        <dt>Duration</dt>
        <dd>{formatPassDuration(pass.durationS)}</dd>
        <dt>Highest elevation</dt>
        <dd>{pass.maxElevationDeg.toFixed(0)}°</dd>
        <dt>Closest approach</dt>
        <dd>
          {pass.minDistanceKm.toFixed(0)} km at {pass.tca.slice(11, 19)}
        </dd>
        <dt>Place below</dt>
        <Daylight day={pass.daylight} sunDeg={pass.sunElevationDeg} />
      </dl>
      <p className={styles.hint}>Click to show it on the timeline</p>
    </div>
  );
}
