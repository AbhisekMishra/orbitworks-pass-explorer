/**
 * Imperative MapLibre + deck.gl glue, kept outside React on purpose: the map subscribes to the
 * store and pushes new layer props synchronously (deck.gl batches the actual redraw into its next
 * frame, so the map never lags the timeline by an extra frame). Scrubbing, playing or toggling
 * satellites therefore never re-renders React components (CLAUDE.md "Web hot path").
 */
import { MapView, _GlobeView as GlobeView, type Layer } from '@deck.gl/core';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { normalizeLon, type Pass } from '@ow/shared';
import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from 'maplibre-gl';

import { sameItems } from '../lib/equality';
import { appStore } from '../state/store';
import type { CameraState, Projection } from '../state/url';
import type { LoadedTracks } from '../tracks/trackBuffers';
import { passPortions, type PassPortion } from '../features/accesses/accessMath';

import type { SatelliteColor } from './colors';
import { createAccessOverlay } from './accessOverlay';
import { PASSES_LAYER_ID, buildLayers, hoverFromPick, isPassPath } from './layers';

/** OpenFreeMap: public OpenStreetMap vector tiles, no API key, no self-hosting. */
export const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
/** First view: Europe, Africa and Asia on the globe (where the example passes are). */
export const DEFAULT_CAMERA: CameraState = { lon: 35, lat: 22, zoom: 1.7 };
/**
 * Used when the public basemap cannot be loaded: tracks, tooltips and the timeline keep working
 * over a plain background instead of the whole map staying blank (deck.gl layers attach to the
 * map only once a style has loaded).
 */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#161d2e' } }],
};
/** Tracks are 2 px wide; a few pixels of slack make them easy to hover. */
const PICKING_RADIUS_PX = 6;

export interface MapController {
  map: MapLibreMap;
  setData: (tracks: LoadedTracks | null, colors: ReadonlyMap<string, SatelliteColor>) => void;
  /** Passes of the current accesses query (drawn as highlighted track portions). */
  setPasses: (passes: readonly Pass[] | undefined) => void;
  /** Layers most recently handed to deck.gl (read by the E2E hooks). */
  layers: () => readonly Layer[];
  /** Pass portions currently drawn (read by the E2E hooks). */
  portions: () => readonly PassPortion[];
  destroy: () => void;
}

/**
 * @deck.gl/mapbox identifies the map's own view by this id. It only re-derives the view on
 * MapLibre's `styledata` event, which `setProjection` does not fire, so the matching view is
 * passed explicitly whenever the projection changes.
 */
const MAPBOX_VIEW_ID = 'mapbox';
const viewPropsFor = (projection: Projection): MapboxOverlayProps => {
  const view =
    projection === 'globe' ? new GlobeView({ id: MAPBOX_VIEW_ID }) : new MapView({ id: MAPBOX_VIEW_ID });
  // MapboxOverlayProps inherits DeckProps' default `views: null` generic; at runtime the overlay
  // accepts a View with the 'mapbox' id (that is exactly what it builds itself on styledata).
  return { views: view } as unknown as MapboxOverlayProps;
};

/**
 * @deck.gl/mapbox 9.4 (interleaved mode) reads `map.transform` (height, elevation, near/far
 * planes), a field MapLibre ≤ 5 had on the map and MapLibre 6 keeps on its camera. Exposing the
 * camera's transform under the old name is the whole compatibility gap; drop this once deck.gl
 * supports MapLibre 6 natively. Covered by the E2E suite (every test renders interleaved layers).
 */
function exposeTransformForDeck(map: MapLibreMap): void {
  if ('transform' in map) return;
  Object.defineProperty(map, 'transform', { configurable: true, get: () => map._camera.transform });
}

export function createMapController(container: HTMLElement): MapController {
  const store = appStore.getState();
  const camera = store.camera ?? DEFAULT_CAMERA;
  const map = new MapLibreMap({
    container,
    style: BASEMAP_STYLE_URL,
    center: [camera.lon, camera.lat],
    zoom: camera.zoom,
    attributionControl: { compact: true },
    // Tracks are ground tracks: a tilted or rotated map adds nothing and makes them harder to read.
    // (World copies stay on: turning them off clamps a camera near the antimeridian while the map
    // is still Mercator, before the globe projection applies, shifting shared links by ~40°.)
    dragRotate: false,
    pitchWithRotate: false,
    maxPitch: 0,
  });
  exposeTransformForDeck(map);
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // Bottom-right: the top-right corner belongs to the accesses panel.
  map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

  let data: { tracks: LoadedTracks; colors: ReadonlyMap<string, SatelliteColor> } | null = null;
  let beforeId: string | undefined;
  let layers: Layer[] = [];
  let passes: readonly Pass[] = [];
  let portions: PassPortion[] = [];
  /** Pass highlighted from the map (not the table or the timeline): the map clears it on leave. */
  let mapHoveredPass: string | null = null;

  const overlay = new MapboxOverlay({
    interleaved: true,
    ...viewPropsFor(store.projection),
    pickingRadius: PICKING_RADIUS_PX,
    layers: [],
    onHover: (info) => {
      const s = appStore.getState();
      const hover = data
        ? hoverFromPick(
            {
              layerId: info.layer?.id,
              index: info.index,
              coordinate: info.coordinate,
              object: info.object,
              x: info.x,
              y: info.y,
            },
            data.tracks,
            s.timeWindow,
          )
        : null;
      if (hover || s.hover) s.setHover(hover);
      if (hover?.kind === 'pass') {
        mapHoveredPass = hover.passId;
        s.setHoveredPass(hover.passId);
      } else if (mapHoveredPass !== null) {
        mapHoveredPass = null;
        s.setHoveredPass(null);
      }
    },
  });
  map.addControl(overlay);

  const render = (): void => {
    if (!data) return;
    const s = appStore.getState();
    layers = buildLayers({
      tracks: data.tracks,
      colors: data.colors,
      timeWindow: s.timeWindow,
      hidden: s.hidden,
      focusedSatellite: s.focusedSatellite,
      passes: s.access.pin ? portions : [],
      hoveredPassId: s.hoveredPassId,
      selectedPassId: s.selectedPassId,
      pinActive: s.access.pin !== null,
      ...(beforeId ? { beforeId } : {}),
    });
    overlay.setProps({ layers });
  };

  // Not map.isStyleLoaded(): that stays false while sprites and glyphs load, which would drop a
  // projection change arriving in that window (e.g. from a shared link). style.load applies the
  // store's projection anyway, so earlier changes are never lost.
  let styleReady = false;
  const setProjection = (projection: Projection): void => {
    if (!styleReady) return;
    map.setProjection({ type: projection });
    overlay.setProps(viewPropsFor(projection));
  };

  const rebuildPortions = (): void => {
    portions = data ? passPortions(passes, data.tracks.tracks, data.colors) : [];
    render();
  };

  const accessOverlay = createAccessOverlay(map, (pin) => {
    appStore.getState().setPin(pin);
  });
  const syncCircle = (): void => {
    const { pin, radiusKm } = appStore.getState().access;
    accessOverlay.update(pin, radiusKm);
  };

  const clearHover = (): void => {
    if (appStore.getState().hover) appStore.getState().setHover(null);
  };

  map.on('style.load', () => {
    styleReady = true;
    setProjection(appStore.getState().projection);
    // Draw tracks beneath the first label layer so place names stay readable on top.
    beforeId = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    accessOverlay.attach(beforeId);
    syncCircle();
    render();
  });
  let usingFallback = false;
  map.on('error', () => {
    // Errors after the style loaded are tile hiccups MapLibre retries on its own.
    if (styleReady || usingFallback) return;
    usingFallback = true;
    map.setStyle(FALLBACK_STYLE);
  });
  map.on('movestart', clearHover);
  // A click on a highlighted pass focuses it; anywhere else drops (or moves) the pin.
  map.on('click', (e) => {
    const hit = overlay.pickObject({
      x: e.point.x,
      y: e.point.y,
      radius: PICKING_RADIUS_PX,
      layerIds: [PASSES_LAYER_ID],
    });
    const hitId = isPassPath(hit?.object) ? hit.object.id : undefined;
    const portion = portions.find((p) => p.id === hitId);
    if (portion)
      appStore.getState().focusPass({ id: portion.id, startS: portion.startS, endS: portion.endS });
    else appStore.getState().setPin({ lon: normalizeLon(e.lngLat.lng), lat: e.lngLat.lat });
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    appStore.getState().setCamera({ lon: normalizeLon(c.lng), lat: c.lat, zoom: map.getZoom() });
  });
  container.addEventListener('mouseleave', clearHover);

  const unsubscribers = [
    appStore.subscribe((s) => [s.timeWindow, s.hidden, s.focusedSatellite] as const, render, {
      equalityFn: sameItems,
    }),
    // The tooltip describes a point that may no longer be drawn: the pointer's next move re-picks.
    appStore.subscribe((s) => [s.timeWindow, s.hidden] as const, clearHover, { equalityFn: sameItems }),
    appStore.subscribe((s) => s.projection, setProjection),
    // Only the pin and radius shape the circle; days and daylight change the query, not the map.
    appStore.subscribe((s) => [s.access.pin, s.access.radiusKm] as const, syncCircle, {
      equalityFn: sameItems,
    }),
    // Tracks recede while a pin is set: re-render only when that flips.
    appStore.subscribe((s) => s.access.pin !== null, render),
    appStore.subscribe((s) => [s.hoveredPassId, s.selectedPassId] as const, render, {
      equalityFn: sameItems,
    }),
    // Focusing a pass from the table or timeline: make sure the place is on screen.
    appStore.subscribe(
      (s) => s.selectedPassId,
      (id) => {
        const { pin } = appStore.getState().access;
        if (id && pin && !map.getBounds().contains([pin.lon, pin.lat]))
          map.easeTo({ center: [pin.lon, pin.lat] });
      },
    ),
  ];

  return {
    map,
    setData(tracks, colors) {
      data = tracks ? { tracks, colors } : null;
      rebuildPortions();
    },
    setPasses(next) {
      passes = next ?? [];
      rebuildPortions();
    },
    layers: () => layers,
    portions: () => portions,
    destroy() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      container.removeEventListener('mouseleave', clearHover);
      accessOverlay.destroy();
      map.remove();
    },
  };
}
