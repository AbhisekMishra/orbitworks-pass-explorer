import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { datasetQuery, tracksQuery } from './api/queries';
import styles from './App.module.css';
import { FirstRunHint } from './components/FirstRunHint';
import { HelpDialog } from './components/HelpDialog';
import { ErrorCard, LoadingCard } from './components/StatusCard';
import { TopBar } from './components/TopBar';
import { SatellitePanel } from './features/satellites/SatellitePanel';
import { Timeline } from './features/timeline/Timeline';
import { TrackTooltip } from './features/tooltip/TrackTooltip';
import { datasetMeta, summarizeDataset } from './lib/dataset';
import { useShortcuts } from './lib/useShortcuts';
import { assignColors } from './map/colors';
import { MapView } from './map/MapView';
import { appStore } from './state/store';
import { parseUrlState } from './state/url';
import { useUrlSync } from './state/useUrlSync';

export function App() {
  const dataset = useQuery(datasetQuery);
  const tracks = useQuery(tracksQuery);

  useShortcuts();
  useUrlSync();

  // The dataset metadata (small, fast) drives the controls; tracks stream in behind them.
  useEffect(() => {
    if (!dataset.data) return;
    appStore.getState().initialize(datasetMeta(dataset.data), parseUrlState(window.location.search));
  }, [dataset.data]);

  const satellites = dataset.data?.satellites;
  const colors = useMemo(() => assignColors((satellites ?? []).map((s) => s.id)), [satellites]);

  const failed = dataset.error ?? tracks.error;
  const retry = () => {
    if (dataset.error) void dataset.refetch();
    if (tracks.error) void tracks.refetch();
  };

  return (
    <div className={styles.app}>
      <TopBar summary={dataset.data ? summarizeDataset(dataset.data) : null} />
      <main className={styles.stage}>
        <MapView tracks={tracks.data?.tracks ?? null} colors={colors} />
        {satellites && <SatellitePanel satellites={satellites} colors={colors} />}
        <TrackTooltip colors={colors} />
        {failed ? (
          <ErrorCard title="Could not load the satellite data" message={failed.message} onRetry={retry} />
        ) : (
          !tracks.data && (
            <LoadingCard
              title="Loading a week of satellite tracks…"
              detail="About 0.5 MB, downloaded once."
            />
          )
        )}
        {tracks.data && <FirstRunHint />}
      </main>
      <Timeline />
      <HelpDialog stats={tracks.data?.stats ?? null} />
    </div>
  );
}
