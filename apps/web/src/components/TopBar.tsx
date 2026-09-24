import { useAppStore } from '../state/store';
import type { Projection } from '../state/url';

import { GlobeIcon, HelpIcon, LogoMark, MapIcon } from './icons';
import styles from './TopBar.module.css';

interface Props {
  /** "Altair-2P5S · 10 satellites · 01 Mar – 07 Mar 2027", once the dataset is known. */
  summary: string | null;
}

const PROJECTIONS: { value: Projection; label: string; Icon: typeof GlobeIcon; hint: string }[] = [
  { value: 'globe', label: 'Globe', Icon: GlobeIcon, hint: 'True shapes and distances (G)' },
  { value: 'mercator', label: 'Flat', Icon: MapIcon, hint: 'Whole world at once (G)' },
];

export function TopBar({ summary }: Readonly<Props>) {
  const projection = useAppStore((s) => s.projection);
  const setProjection = useAppStore((s) => s.setProjection);
  const setHelpOpen = useAppStore((s) => s.setHelpOpen);

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <LogoMark size={22} className={styles.logo} />
        <span className={styles.name}>
          Orbitworks <strong>Pass Explorer</strong>
        </span>
      </div>
      {summary && (
        <p className={styles.summary} data-testid="dataset-summary">
          {summary}
        </p>
      )}
      <div className={styles.actions}>
        <span className={styles.utc} title="Every date and time in this app is Coordinated Universal Time">
          All times UTC
        </span>
        <div className={styles.segmented} role="group" aria-label="Map projection">
          {PROJECTIONS.map(({ value, label, Icon, hint }) => (
            <button
              key={value}
              type="button"
              className={styles.segment}
              aria-pressed={projection === value}
              title={hint}
              onClick={() => {
                setProjection(value);
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.help}
          aria-label="Help and keyboard shortcuts"
          title="Help and keyboard shortcuts (?)"
          onClick={() => {
            setHelpOpen(true);
          }}
        >
          <HelpIcon size={18} />
        </button>
      </div>
    </header>
  );
}
