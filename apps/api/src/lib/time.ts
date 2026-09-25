import { MS_PER_DAY, MS_PER_SECOND } from '@ow/shared';

export const roundToSecond = (ms: number): number => Math.round(ms / MS_PER_SECOND) * MS_PER_SECOND;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
/** "2027-03-01T" per UTC day: a response has at most ~8 distinct days, so the cache stays tiny. */
const DAY_PREFIX_CACHE_LIMIT = 64;
const dayPrefixes = new Map<number, string>();

function dayPrefix(day: number): string {
  let prefix = dayPrefixes.get(day);
  if (prefix === undefined) {
    prefix = new Date(day * MS_PER_DAY).toISOString().slice(0, 'YYYY-MM-DDT'.length);
    if (dayPrefixes.size >= DAY_PREFIX_CACHE_LIMIT) dayPrefixes.clear();
    dayPrefixes.set(day, prefix);
  }
  return prefix;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * ISO-8601 UTC with second precision and no redundant ".000": 2027-03-01T06:57:59Z.
 * Same output as `toISOString()` (tested), but the date part is cached per day and the time is
 * formatted arithmetically: a polar /accesses response formats ~3,200 of these, and building a
 * Date for each was a measurable share of the query.
 */
export function isoSeconds(ms: number): string {
  const totalS = roundToSecond(ms) / MS_PER_SECOND;
  const day = Math.floor(totalS / (MS_PER_DAY / MS_PER_SECOND));
  const s = totalS - day * (MS_PER_DAY / MS_PER_SECOND);
  const hh = Math.floor(s / SECONDS_PER_HOUR);
  const mm = Math.floor((s % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const ss = s % SECONDS_PER_MINUTE;
  return `${dayPrefix(day)}${pad2(hh)}:${pad2(mm)}:${pad2(ss)}Z`;
}
