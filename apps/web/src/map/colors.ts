/**
 * One color per satellite, shared by the map, the side panel and (later) the accesses table so a
 * satellite is recognizable everywhere. Ten evenly spaced hues at a lightness that reads on the dark
 * basemap, ordered so neighbours in the list contrast strongly.
 */
export type Rgb = readonly [number, number, number];

export const SATELLITE_PALETTE: readonly string[] = [
  '#22d3ee', // cyan
  '#fb923c', // orange
  '#e879f9', // fuchsia
  '#a3e635', // lime
  '#60a5fa', // blue
  '#f87171', // red
  '#facc15', // yellow
  '#a78bfa', // violet
  '#34d399', // green
  '#f472b6', // pink
];

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export interface SatelliteColor {
  hex: string;
  /** Stable array instance: deck.gl compares constant accessors by reference. */
  rgb: Rgb;
}

/** Colors by position in the (sorted) satellite list, cycling past the palette size. */
export function assignColors(satellites: readonly string[]): ReadonlyMap<string, SatelliteColor> {
  return new Map(
    satellites.map((id, i) => {
      const hex = SATELLITE_PALETTE[i % SATELLITE_PALETTE.length] ?? '#ffffff';
      return [id, { hex, rgb: hexToRgb(hex) }];
    }),
  );
}
