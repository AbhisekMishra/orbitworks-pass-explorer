import 'maplibre-gl/dist/maplibre-gl.css';

import type { Pass } from '@ow/shared';
import { memo, useEffect, useRef } from 'react';

import type { LoadedTracks } from '../tracks/trackBuffers';

import type { SatelliteColor } from './colors';
import { createMapController, type MapController } from './mapController';
import styles from './MapView.module.css';

interface Props {
  tracks: LoadedTracks | null;
  colors: ReadonlyMap<string, SatelliteColor>;
  /** Passes of the accesses query, drawn as highlighted track portions. */
  passes: readonly Pass[] | undefined;
}

/** Mounts the map once; data changes are pushed to the controller, never re-creating the map. */
/** Memoized: re-rendering never touches the map, but it avoids needless effect checks. */
export const MapView = memo(function MapView({ tracks, colors, passes }: Readonly<Props>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MapController | null>(null);
  const tracksRef = useRef<LoadedTracks | null>(tracks);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = createMapController(container);
    controllerRef.current = controller;
    let mounted = true;
    if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') {
      void import('../testing/e2eHooks').then((m) => {
        // StrictMode mounts twice; only the controller still mounted may own the hooks.
        if (mounted) m.installE2EHooks(controller, () => tracksRef.current);
      });
    }
    return () => {
      mounted = false;
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    tracksRef.current = tracks;
    controllerRef.current?.setData(tracks, colors);
  }, [tracks, colors]);

  useEffect(() => {
    controllerRef.current?.setPasses(passes);
  }, [passes]);

  return <div ref={containerRef} className={styles.map} data-testid="map" />;
});
