import { useEffect } from 'react';

import { appStore } from '../state/store';

import { shortcutFor, type ShortcutAction } from './shortcuts';

function dispatch(action: ShortcutAction): void {
  const s = appStore.getState();
  switch (action.type) {
    case 'togglePlay':
      s.togglePlaying();
      break;
    case 'toggleSatellite':
    case 'soloSatellite': {
      const id = s.satellites[action.index];
      if (id !== undefined) {
        if (action.type === 'toggleSatellite') s.toggleSatellite(id);
        else s.soloSatellite(id);
      }
      break;
    }
    case 'showAllSatellites':
      s.showAllSatellites();
      break;
    case 'nudgeWindow':
      s.nudgeWindow(action.spans);
      break;
    case 'toggleProjection':
      s.toggleProjection();
      break;
    case 'openHelp':
      s.setHelpOpen(true);
      break;
  }
}

/** Handles a keydown; returns whether it was a shortcut (exported for tests). */
export function handleShortcutKey(event: KeyboardEvent): boolean {
  if (appStore.getState().helpOpen) return false; // the dialog owns the keyboard
  const target = event.target instanceof HTMLElement ? event.target : null;
  const action = shortcutFor({
    key: event.key,
    code: event.code,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    targetTag: target?.tagName.toLowerCase() ?? '',
    targetEditable: target?.isContentEditable ?? false,
  });
  if (!action) return false;
  event.preventDefault();
  dispatch(action);
  return true;
}

export function useShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey);
    return () => {
      window.removeEventListener('keydown', handleShortcutKey);
    };
  }, []);
}
