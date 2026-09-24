import { MS_PER_SECOND } from '@ow/shared';

export const roundToSecond = (ms: number): number => Math.round(ms / MS_PER_SECOND) * MS_PER_SECOND;

/** ISO-8601 UTC with second precision and no redundant ".000": 2027-03-01T06:57:59Z. */
export const isoSeconds = (ms: number): string =>
  new Date(roundToSecond(ms)).toISOString().replace('.000Z', 'Z');
