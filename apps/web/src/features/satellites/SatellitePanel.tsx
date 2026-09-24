import type { SatelliteSummary } from '@ow/shared';
import { memo, useState, type CSSProperties } from 'react';

import { ChevronIcon } from '../../components/icons';
import type { SatelliteColor } from '../../map/colors';
import { useAppStore } from '../../state/store';

import styles from './SatellitePanel.module.css';

interface Props {
  satellites: readonly SatelliteSummary[];
  colors: ReadonlyMap<string, SatelliteColor>;
}

/** Keyboard digit for the first ten satellites: 1…9, then 0. */
const shortcutDigit = (index: number): string | null => (index < 10 ? String((index + 1) % 10) : null);

/** Memoized: App re-renders while the accesses controls move; this panel does not need to. */
export const SatellitePanel = memo(function SatellitePanel({ satellites, colors }: Readonly<Props>) {
  const hidden = useAppStore((s) => s.hidden);
  const toggle = useAppStore((s) => s.toggleSatellite);
  const solo = useAppStore((s) => s.soloSatellite);
  const showAll = useAppStore((s) => s.showAllSatellites);
  const hideAll = useAppStore((s) => s.hideAllSatellites);
  const setFocused = useAppStore((s) => s.setFocusedSatellite);
  const [collapsed, setCollapsed] = useState(false);

  const visibleCount = satellites.length - satellites.filter((s) => hidden.has(s.id)).length;

  return (
    <section className={styles.panel} aria-label="Satellites" data-collapsed={collapsed}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.title}
          aria-expanded={!collapsed}
          aria-controls="satellite-list"
          onClick={() => {
            setCollapsed((c) => !c);
          }}
        >
          <ChevronIcon size={14} className={styles.chevron} />
          Satellites
          <span className={styles.count} data-testid="satellite-count">
            {visibleCount}/{satellites.length}
          </span>
        </button>
        <div className={styles.bulk}>
          <button
            type="button"
            onClick={showAll}
            disabled={visibleCount === satellites.length}
            title="Show all (A)"
          >
            All
          </button>
          <button type="button" onClick={hideAll} disabled={visibleCount === 0}>
            None
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          <ul
            id="satellite-list"
            className={styles.list}
            onMouseLeave={() => {
              setFocused(null);
            }}
          >
            {satellites.map((sat, i) => {
              const visible = !hidden.has(sat.id);
              const digit = shortcutDigit(i);
              return (
                <li
                  key={sat.id}
                  className={styles.row}
                  data-visible={visible}
                  style={{ '--sat-color': colors.get(sat.id)?.hex } as CSSProperties}
                  onMouseEnter={() => {
                    setFocused(visible ? sat.id : null);
                  }}
                >
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      aria-label={sat.id}
                      checked={visible}
                      onChange={() => {
                        toggle(sat.id);
                      }}
                    />
                    <span className={styles.swatch} aria-hidden="true" />
                    <span className={styles.id}>{sat.id}</span>
                    <span className={styles.meta}>
                      {Math.round(sat.minAltitudeKm)}–{Math.round(sat.maxAltitudeKm)} km
                    </span>
                  </label>
                  <button
                    type="button"
                    className={styles.only}
                    aria-label={`Show only ${sat.id}`}
                    title={digit ? `Show only ${sat.id} (Shift+${digit})` : `Show only ${sat.id}`}
                    onClick={() => {
                      solo(sat.id);
                    }}
                  >
                    Only
                  </button>
                  {digit && <kbd className={styles.kbd}>{digit}</kbd>}
                </li>
              );
            })}
          </ul>
          <p className={styles.hint}>Hover a satellite to highlight its track.</p>
        </>
      )}
    </section>
  );
});
