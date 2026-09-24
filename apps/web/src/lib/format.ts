/** Display formatting for coordinates and sizes (times are in ./time.ts). */

/** "24.45° N" */
export const formatLat = (lat: number, digits = 2): string =>
  `${Math.abs(lat).toFixed(digits)}° ${lat < 0 ? 'S' : 'N'}`;

/** "54.37° E" */
export const formatLon = (lon: number, digits = 2): string =>
  `${Math.abs(lon).toFixed(digits)}° ${lon < 0 ? 'W' : 'E'}`;

/** "0.51 MB", "780 KB", "512 B" (decimal units, like browser devtools). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}
