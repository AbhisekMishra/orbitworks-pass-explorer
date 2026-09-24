/** Component-test helpers: a fresh global store per test, initialized with a small dataset. */
import type { SatelliteSummary } from '@ow/shared';

import { assignColors } from '../map/colors';
import { appStore } from '../state/store';

export const T0 = Date.UTC(2027, 2, 1) / 1000;
export const H = 3600;
export const WEEK = { startS: T0, endS: T0 + 7 * 24 * H };
export const SATELLITE_IDS = ['YAM20', 'YAM21', 'YAM22'];

export const SATELLITES: SatelliteSummary[] = SATELLITE_IDS.map((id, i) => ({
  id,
  start: '2027-03-01T00:00:00.000Z',
  end: '2027-03-08T00:00:00.000Z',
  segmentCount: 10_080,
  minAltitudeKm: 490 + i,
  maxAltitudeKm: 540 + i,
}));

export const COLORS = assignColors(SATELLITE_IDS);

/** Resets the app store to its initial state and loads the test dataset. */
export function resetStore({ initialized = true }: { initialized?: boolean } = {}): void {
  appStore.setState(appStore.getInitialState(), true);
  if (initialized) appStore.getState().initialize({ bounds: WEEK, satellites: SATELLITE_IDS });
}
