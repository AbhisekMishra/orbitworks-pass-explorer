/**
 * The API contract: the single source of truth for request validation (API) and response typing
 * (web). Query-string schemas accept strings (as parsed by the HTTP layer) and output typed values.
 */
import { z } from 'zod';

import {
  INSTANT_RANGE_MS,
  MAX_GEOJSON_SPAN_HOURS,
  MAX_QUERY_SPAN_DAYS,
  MAX_SATELLITES_PER_QUERY,
  MS_PER_DAY,
  MS_PER_HOUR,
  RADIUS_KM,
  SATELLITE_ID_PATTERN,
} from './constants.js';

// ---------------------------------------------------------------------------------------------
// Primitives

export const SatelliteIdSchema = z
  .string()
  .regex(SATELLITE_ID_PATTERN, 'Satellite ids are 1–32 characters: letters, digits, "_" or "-"');

/**
 * Satellite list from a query string: "A,B", repeated params (["A", "B"]) or a mix.
 * Output: de-duplicated ids in first-seen order.
 */
export const SatelliteListSchema = z
  .preprocess((value: unknown): unknown[] => {
    const items: unknown[] = Array.isArray(value) ? value : [value];
    return items.flatMap((v): unknown[] =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
        : [v],
    );
  }, z.array(SatelliteIdSchema).min(1, 'Provide at least one satellite id, or omit the parameter for all satellites').max(MAX_SATELLITES_PER_QUERY))
  .transform((ids) => [...new Set(ids)])
  .describe('Comma-separated satellite ids (or repeated parameter)');

const DATE_ONLY_LENGTH = 'YYYY-MM-DD'.length;

/**
 * A UTC instant: full ISO-8601 with an explicit offset ("Z" or ±hh:mm) or a date (UTC midnight).
 * Offset-less local times are rejected as ambiguous. Output: epoch milliseconds.
 */
export const UtcInstantSchema = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((s) => Date.parse(s.length === DATE_ONLY_LENGTH ? `${s}T00:00:00Z` : s))
  .pipe(
    z
      .number()
      .min(INSTANT_RANGE_MS.min, 'Instants must be within 2000–2099')
      .lt(INSTANT_RANGE_MS.max, 'Instants must be within 2000–2099'),
  )
  .describe('ISO-8601 instant with offset, e.g. 2027-03-01T06:00:00Z, or a date (UTC midnight)');

/** Only decimal-notation characters: excludes hex (0x…), "Infinity", "NaN", "1_000". Linear-time. */
const DECIMAL_CHARS = /^[\d.eE+-]+$/;

/** Parses a decimal string; NaN for anything else (empty, whitespace, hex, Infinity, "1.2.3", "--1"). */
function parseDecimal(raw: string): number {
  const s = raw.trim();
  return DECIMAL_CHARS.test(s) ? Number(s) : NaN;
}

/**
 * Strict numeric query parameter. Unlike z.coerce.number(), empty strings, whitespace, "Infinity"
 * and hex are rejected instead of silently becoming 0 / Infinity / 255.
 */
const numberParam = (min: number, max: number) =>
  z
    .union([z.number(), z.string().transform(parseDecimal)])
    .pipe(z.number({ error: 'Expected a decimal number' }).min(min).max(max));

interface TimeWindow {
  start?: number;
  end?: number;
}

function checkWindow(q: TimeWindow, ctx: z.RefinementCtx, maxSpanMs: number, spanLabel: string): void {
  if (q.start === undefined || q.end === undefined) return;
  if (q.start >= q.end) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: '"end" must be after "start"' });
  } else if (q.end - q.start > maxSpanMs) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: `Time window must not exceed ${spanLabel}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Requests

export const TRACK_FORMATS = ['geojson', 'binary'] as const;

export const TracksQuerySchema = z
  .object({
    satellites: SatelliteListSchema.optional(),
    start: UtcInstantSchema.optional(),
    end: UtcInstantSchema.optional(),
    format: z.enum(TRACK_FORMATS).default('geojson'),
  })
  .superRefine((q, ctx) => {
    if (q.format === 'geojson') {
      if (q.start === undefined || q.end === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['start'],
          message: `GeoJSON requires "start" and "end" (≤ ${MAX_GEOJSON_SPAN_HOURS} h); use format=binary for the full dataset`,
        });
        return;
      }
      checkWindow(
        q,
        ctx,
        MAX_GEOJSON_SPAN_HOURS * MS_PER_HOUR,
        `${MAX_GEOJSON_SPAN_HOURS} hours for GeoJSON`,
      );
    } else {
      checkWindow(q, ctx, MAX_QUERY_SPAN_DAYS * MS_PER_DAY, `${MAX_QUERY_SPAN_DAYS} days`);
    }
  });
export type TracksQuery = z.output<typeof TracksQuerySchema>;

export const AccessesQuerySchema = z
  .object({
    lat: numberParam(-90, 90),
    lon: numberParam(-180, 180),
    radiusKm: numberParam(RADIUS_KM.min, RADIUS_KM.max).default(RADIUS_KM.default),
    start: UtcInstantSchema.optional(),
    end: UtcInstantSchema.optional(),
    satellites: SatelliteListSchema.optional(),
    daylightOnly: z.stringbool().default(false),
  })
  .superRefine((q, ctx) => {
    checkWindow(q, ctx, MAX_QUERY_SPAN_DAYS * MS_PER_DAY, `${MAX_QUERY_SPAN_DAYS} days`);
  });
export type AccessesQuery = z.output<typeof AccessesQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Responses

const IsoInstant = z.iso.datetime();
const LonLat = z.tuple([z.number(), z.number()]);

export const SatelliteSummarySchema = z.object({
  id: SatelliteIdSchema,
  start: IsoInstant,
  end: IsoInstant,
  segmentCount: z.number().int().nonnegative(),
  minAltitudeKm: z.number(),
  maxAltitudeKm: z.number(),
});
export type SatelliteSummary = z.infer<typeof SatelliteSummarySchema>;

export const DatasetSchema = z.object({
  name: z.string(),
  start: IsoInstant,
  end: IsoInstant,
  /** Seconds between consecutive track vertices. */
  stepS: z.number().positive(),
  satellites: z.array(SatelliteSummarySchema),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const TrackFeatureSchema = z.object({
  type: z.literal('Feature'),
  geometry: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(z.tuple([z.number(), z.number(), z.number()])),
  }),
  properties: z.object({ satellite: SatelliteIdSchema, start: IsoInstant, end: IsoInstant }),
});

export const TracksGeoJsonSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(TrackFeatureSchema),
});
export type TracksGeoJson = z.infer<typeof TracksGeoJsonSchema>;

export const PassDirectionSchema = z.enum(['ascending', 'descending']);
export type PassDirection = z.infer<typeof PassDirectionSchema>;

export const PassSchema = z.object({
  id: z.string(),
  satellite: SatelliteIdSchema,
  /** Acquisition of signal: the track enters the circle. */
  start: IsoInstant,
  /** Loss of signal: the track leaves the circle. */
  end: IsoInstant,
  durationS: z.number().nonnegative(),
  /** Time of closest approach. */
  tca: IsoInstant,
  minDistanceKm: z.number().nonnegative(),
  maxElevationDeg: z.number(),
  /** Sun elevation at the target at TCA: > 0 means the ground is lit (optical imaging possible). */
  sunElevationDeg: z.number(),
  daylight: z.boolean(),
  direction: PassDirectionSchema,
  /** Mean local solar time at TCA, hours [0, 24). */
  localSolarTimeH: z.number().min(0).lt(24),
  altitudeKm: z.number(),
  /** Portion of the ground track inside the circle, [lon, lat] with continuous longitudes. */
  path: z.array(LonLat),
});
export type Pass = z.infer<typeof PassSchema>;

export const AccessStatsSchema = z.object({
  passCount: z.number().int().nonnegative(),
  totalDurationS: z.number().nonnegative(),
  bySatellite: z.record(z.string(), z.number().int().nonnegative()),
  /** Mean time between the starts of consecutive passes (any satellite); null with < 2 passes. */
  meanRevisitS: z.number().nonnegative().nullable(),
  /** Longest period without coverage between consecutive passes; null with < 2 passes. */
  maxGapS: z.number().nonnegative().nullable(),
});
export type AccessStats = z.infer<typeof AccessStatsSchema>;

export const AccessesResponseSchema = z.object({
  query: z.object({
    lat: z.number(),
    lon: z.number(),
    radiusKm: z.number(),
    start: IsoInstant,
    end: IsoInstant,
    satellites: z.array(SatelliteIdSchema),
    daylightOnly: z.boolean(),
  }),
  passes: z.array(PassSchema),
  stats: AccessStatsSchema,
});
export type AccessesResponse = z.infer<typeof AccessesResponseSchema>;

export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
