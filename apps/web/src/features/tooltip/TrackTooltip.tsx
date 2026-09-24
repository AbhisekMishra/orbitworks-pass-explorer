import { DAYLIGHT_SUN_ELEVATION_DEG, MS_PER_SECOND, meanLocalSolarTimeH, sunElevationDeg } from '@ow/shared';
import type { CSSProperties } from 'react';

import { MoonIcon, SunIcon } from '../../components/icons';
import { formatLat, formatLon } from '../../lib/format';
import { formatDate, formatHours, formatTime } from '../../lib/time';
import type { SatelliteColor } from '../../map/colors';
import { useAppStore } from '../../state/store';

import styles from './TrackTooltip.module.css';

interface Props {
  colors: ReadonlyMap<string, SatelliteColor>;
}

/** Pointer offset, and the width past which the tooltip flips to the left of the pointer. */
const OFFSET_PX = 14;
const FLIP_MARGIN_PX = 280;

/**
 * What is under the pointer: which satellite, exactly when it was there, and whether the ground
 * below was sunlit (the property that matters for optical imaging).
 */
export function TrackTooltip({ colors }: Readonly<Props>) {
  const hover = useAppStore((s) => s.hover);
  if (!hover) return null;

  const ms = hover.timeS * MS_PER_SECOND;
  const sunDeg = sunElevationDeg(ms, hover.lon, hover.lat);
  const day = sunDeg > DAYLIGHT_SUN_ELEVATION_DEG;
  const flip = hover.x > globalThis.innerWidth - FLIP_MARGIN_PX;
  const dx = flip ? `calc(-100% - ${OFFSET_PX}px)` : `${OFFSET_PX}px`;
  const style = {
    left: hover.x,
    top: hover.y,
    transform: `translate(${dx}, ${OFFSET_PX}px)`,
    '--sat-color': colors.get(hover.satellite)?.hex,
  } as CSSProperties;

  return (
    <div className={styles.tooltip} style={style} role="tooltip" data-testid="track-tooltip">
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
        <dd className={day ? styles.day : styles.night}>
          {day ? <SunIcon size={12} /> : <MoonIcon size={12} />}
          {day ? 'Sunlit' : 'Dark'} (Sun {sunDeg.toFixed(0)}°)
        </dd>
      </dl>
    </div>
  );
}
