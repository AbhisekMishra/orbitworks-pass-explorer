import { useState } from 'react';

import styles from './FirstRunHint.module.css';
import { CloseIcon } from './icons';

/** Bump the version to show the hint again after a UX change. */
export const HINT_STORAGE_KEY = 'ow.firstRunHint.v1';

function wasDismissed(): boolean {
  try {
    return globalThis.localStorage.getItem(HINT_STORAGE_KEY) === 'dismissed';
  } catch {
    return false; // storage disabled (private mode, policies): just show the hint
  }
}

/** A one-time orientation card above the timeline; dismissed for good once closed. */
export function FirstRunHint() {
  const [visible, setVisible] = useState(() => !wasDismissed());
  if (!visible) return null;
  const dismiss = () => {
    setVisible(false);
    try {
      globalThis.localStorage.setItem(HINT_STORAGE_KEY, 'dismissed');
    } catch {
      // Not persisted; it will show again next visit.
    }
  };
  return (
    <aside className={styles.hint} aria-label="Getting started" data-testid="first-run-hint">
      <p>
        <strong>Drag the blue window</strong> on the timeline to choose which part of the week is drawn, and
        toggle satellites on the left. Hover a track for details, press <kbd>Space</kbd> to play, <kbd>?</kbd>{' '}
        for all shortcuts.
      </p>
      <button type="button" className={styles.dismiss} onClick={dismiss}>
        Got it
      </button>
      <button type="button" className={styles.close} aria-label="Dismiss hint" onClick={dismiss}>
        <CloseIcon size={14} />
      </button>
    </aside>
  );
}
