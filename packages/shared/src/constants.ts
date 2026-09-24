/** IUGG mean Earth radius. All ground distances in the app are great-circle distances on this sphere. */
export const EARTH_RADIUS_KM = 6371.0088;

/** Limits for the access radius. The upper bound is roughly the 0° elevation horizon of a 500 km LEO. */
export const RADIUS_KM = { min: 10, max: 2500, default: 400 } as const;

/** Hard cap on the number of satellites accepted in a single query string (defensive input bound). */
export const MAX_SATELLITES_PER_QUERY = 64;

/** Daylight threshold for passes: the Sun must be above the geometric horizon at the target. */
export const DAYLIGHT_SUN_ELEVATION_DEG = 0;
