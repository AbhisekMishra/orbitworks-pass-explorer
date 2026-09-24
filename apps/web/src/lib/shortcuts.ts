/**
 * Global keyboard shortcuts, as a pure key → action map (the React hook only dispatches).
 * Digits use `code` so Shift+digit works on every keyboard layout.
 */
export type ShortcutAction =
  | { type: 'togglePlay' }
  | { type: 'toggleSatellite'; index: number }
  | { type: 'soloSatellite'; index: number }
  | { type: 'showAllSatellites' }
  | { type: 'nudgeWindow'; spans: number }
  | { type: 'toggleProjection' }
  | { type: 'openHelp' };

export interface KeyInput {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Lower-case tag name of the event target, and whether it is editable. */
  targetTag: string;
  targetEditable: boolean;
}

/** Arrow keys move the window by this fraction of its span (Shift: a whole span). */
export const NUDGE_SPANS = 0.1;

const TYPING_TAGS = new Set(['input', 'select', 'textarea']);
/** Controls where Space/arrows already mean something (activate a button, pan the map). */
const OWN_KEYS_TAGS = new Set(['button', 'canvas', 'a', 'summary']);

function digitIndex(code: string): number | null {
  const m = /^Digit(\d)$/.exec(code);
  if (!m) return null;
  const d = Number(m[1]);
  return d === 0 ? 9 : d - 1;
}

export function shortcutFor(e: KeyInput): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.targetEditable || TYPING_TAGS.has(e.targetTag)) return null;

  const index = digitIndex(e.code);
  if (index !== null)
    return e.shiftKey ? { type: 'soloSatellite', index } : { type: 'toggleSatellite', index };
  if (e.key === '?') return { type: 'openHelp' };
  if (e.key === 'a' || e.key === 'A') return { type: 'showAllSatellites' };
  if (e.key === 'g' || e.key === 'G') return { type: 'toggleProjection' };

  if (OWN_KEYS_TAGS.has(e.targetTag)) return null;
  if (e.key === ' ') return { type: 'togglePlay' };
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const spans = e.shiftKey ? 1 : NUDGE_SPANS;
    return { type: 'nudgeWindow', spans: e.key === 'ArrowLeft' ? -spans : spans };
  }
  return null;
}
