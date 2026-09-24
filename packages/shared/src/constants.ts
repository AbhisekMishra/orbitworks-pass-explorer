/** IUGG mean Earth radius. All ground distances in the app are great-circle distances on this sphere. */
export const EARTH_RADIUS_KM = 6371.0088;

export const MS_PER_SECOND = 1000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** Limits for the access radius. The upper bound is roughly the 0° elevation horizon of a 500 km LEO. */
export const RADIUS_KM = { min: 10, max: 2500, default: 400 } as const;

export const API_PREFIX = '/api/v1';

/** Longest time window accepted by any query (defensive bound; the dataset spans one week). */
export const MAX_QUERY_SPAN_DAYS = 31;

/** Instants outside this range are rejected as nonsensical input (bounds one-sided windows too). */
export const INSTANT_RANGE_MS = { min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) } as const;

/**
 * GeoJSON is ~40× larger than the binary track format (59 MB for the week) and costs ~200 ms of
 * server CPU per 24 h of all satellites, so the GeoJSON representation is limited to this window.
 */
export const MAX_GEOJSON_SPAN_HOURS = 6;

/**
 * Filtered binary streams are encoded on demand; anything larger than this should download the
 * full precompressed stream (0.5 MB, cached) and filter locally. Caps per-request CPU at ~10 ms.
 */
export const MAX_FILTERED_BINARY_SPAN_HOURS = 24;

/** Hard cap on the number of satellites accepted in a single query string (defensive input bound). */
export const MAX_SATELLITES_PER_QUERY = 64;

/** Satellite ids everywhere (query strings, codec headers, UI): 1–32 of [A-Za-z0-9_-]. */
export const SATELLITE_ID_PATTERN = /^[\w-]{1,32}$/;

/** Daylight threshold for passes: the Sun must be above the geometric horizon at the target. */
export const DAYLIGHT_SUN_ELEVATION_DEG = 0;
