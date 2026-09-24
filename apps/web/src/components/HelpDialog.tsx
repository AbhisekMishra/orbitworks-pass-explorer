import { useEffect, useRef } from 'react';

import { formatBytes } from '../lib/format';
import { useAppStore } from '../state/store';
import type { LoadStats } from '../tracks/protocol';

import styles from './HelpDialog.module.css';
import { CloseIcon } from './icons';

interface Props {
  stats: LoadStats | null;
}

const SHORTCUTS: [keys: string[], action: string][] = [
  [['Space'], 'Play / pause'],
  [['←', '→'], 'Move the time window (Shift: by a whole window)'],
  [['1', '…', '0'], 'Show / hide satellite 1–10'],
  [['Shift', '1…0'], 'Show only that satellite'],
  [['A'], 'Show all satellites'],
  [['G'], 'Switch globe / flat map'],
  [['?'], 'This help'],
];

/** How to use the app, keyboard shortcuts and what was loaded. Native <dialog>: focus trap and Esc. */
export function HelpDialog({ stats }: Readonly<Props>) {
  const open = useAppStore((s) => s.helpOpen);
  const setOpen = useAppStore((s) => s.setHelpOpen);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="help-title"
      onClose={() => {
        setOpen(false);
      }}
      onClick={(e) => {
        // A click on the backdrop targets the dialog element itself.
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <h2 id="help-title">How to use Pass Explorer</h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close help"
            onClick={() => {
              setOpen(false);
            }}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <ol className={styles.steps}>
          <li>
            <strong>Pick satellites</strong> in the panel on the left. Hover one to highlight its track.
          </li>
          <li>
            <strong>Choose a time window</strong> on the timeline: drag it, drag its edges, click to jump, or
            type exact times. Only the tracks flown inside the window are drawn; the older part fades.
          </li>
          <li>
            <strong>Press play</strong> to slide the window forward; the dots show where each satellite is at
            the end of the window.
          </li>
          <li>
            <strong>Hover a track</strong> to see when the satellite was there, its altitude and whether the
            ground below was sunlit.
          </li>
        </ol>

        <h3>Keyboard</h3>
        <table className={styles.keys}>
          <tbody>
            {SHORTCUTS.map(([keys, action]) => (
              <tr key={action}>
                <td>
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </td>
                <td>{action}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className={styles.note}>
          All dates and times are <strong>UTC</strong>. The whole week of tracks is downloaded once
          {stats?.transferBytes ? ` (${formatBytes(stats.transferBytes)})` : ''} and filtered on your GPU, so
          changing filters never waits for the network.
        </p>
      </div>
    </dialog>
  );
}
