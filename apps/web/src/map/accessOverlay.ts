/**
 * The accesses pin and its radius circle on the map.
 *
 * The circle uses MapLibre's own fill and line layers, not deck.gl: MapLibre drapes fills on the
 * globe, whereas a flat deck.gl polygon of up to 2,500 km radius would cut hundreds of kilometres
 * below the curved surface and vanish. The pin is a draggable MapLibre marker (DOM), so dragging
 * it is native and accessible.
 */
import { normalizeLon } from '@ow/shared';
import { Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';

import { circleData } from '../features/accesses/accessMath';
import type { LonLatPoint } from '../state/store';

import styles from './MapView.module.css';

const SOURCE_ID = 'access-circle';
const FILL_LAYER_ID = 'access-circle-fill';
const LINE_LAYER_ID = 'access-circle-line';
const ACCENT = '#38bdf8';
const FILL_OPACITY = 0.1;
const LINE_WIDTH_PX = 1.5;

const PIN_SVG = `<svg viewBox="0 0 24 32" width="26" height="34" aria-hidden="true">
  <path d="M12 31s-10-10-10-18a10 10 0 0 1 20 0c0 8-10 18-10 18z" fill="${ACCENT}" stroke="#03050b" stroke-width="1.5"/>
  <circle cx="12" cy="12.5" r="3.6" fill="#03050b"/></svg>`;

export interface AccessOverlay {
  /** (Re)creates the circle layers: call after every style load (they belong to the style). */
  attach: (beforeId: string | undefined) => void;
  update: (pin: LonLatPoint | null, radiusKm: number) => void;
  destroy: () => void;
}

export function createAccessOverlay(map: MapLibreMap, onPinMoved: (pin: LonLatPoint) => void): AccessOverlay {
  let current: { pin: LonLatPoint | null; radiusKm: number } = { pin: null, radiusKm: 0 };

  const element = document.createElement('div');
  element.className = styles.pin ?? '';
  element.innerHTML = PIN_SVG;
  element.title = 'Drag to move the pin';
  const marker = new Marker({ element, draggable: true, anchor: 'bottom' });
  marker.on('dragend', () => {
    const { lng, lat } = marker.getLngLat();
    onPinMoved({ lon: normalizeLon(lng), lat });
  });
  // Clicking the pin must not also drop a new pin on the map underneath.
  element.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const source = (): GeoJSONSource | undefined => map.getSource<GeoJSONSource>(SOURCE_ID);

  return {
    attach(beforeId) {
      if (source()) return;
      map.addSource(SOURCE_ID, { type: 'geojson', data: circleData(current.pin, current.radiusKm) });
      map.addLayer(
        {
          id: FILL_LAYER_ID,
          type: 'fill',
          source: SOURCE_ID,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': ACCENT, 'fill-opacity': FILL_OPACITY },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LINE_LAYER_ID,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: { 'line-color': ACCENT, 'line-width': LINE_WIDTH_PX, 'line-dasharray': [3, 2] },
        },
        beforeId,
      );
    },
    update(pin, radiusKm) {
      current = { pin, radiusKm };
      // setData resolves once the worker has processed the geometry; nothing waits on it.
      void source()?.setData(circleData(pin, radiusKm));
      if (pin) marker.setLngLat([pin.lon, pin.lat]).addTo(map);
      else marker.remove();
    },
    destroy() {
      marker.remove();
    },
  };
}
