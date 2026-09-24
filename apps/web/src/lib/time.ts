/**
 * UTC formatting. Everything in the app is UTC (CLAUDE.md), so formatting slices the ISO string
 * instead of going through Intl: deterministic across browsers and locales, and much faster.
 */
import { MS_PER_SECOND } from '@ow/shared';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86_400;

const iso = (epochS: number): string => new Date(epochS * MS_PER_SECOND).toISOString();

/** "2027-03-01 06:58" */
export const formatDateTime = (epochS: number): string => iso(epochS).slice(0, 16).replace('T', ' ');

/** "06:58:30" */
export const formatTime = (epochS: number): string => iso(epochS).slice(11, 19);

/** "Mon 01 Mar" */
export function formatDay(epochS: number): string {
  const d = new Date(epochS * MS_PER_SECOND);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()] ?? ''} ${day} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

/** Value for <input type="datetime-local">, interpreted as UTC by this app: "2027-03-01T06:58". */
export const toDateTimeInput = (epochS: number): string => iso(epochS).slice(0, 16);

/**
 * Parses "YYYY-MM-DDTHH:mm" as UTC. Returns null for malformed or impossible values: Date.parse
 * rolls "02-30" over to March, so the result must format back to the same text.
 */
export function parseUtcMinute(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 16) !== value ? null : ms / MS_PER_SECOND;
}

/** Parses a datetime-local value as UTC. Returns null for empty, malformed or impossible input. */
export const fromDateTimeInput = parseUtcMinute;

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;

/**
 * Compact human duration: "45 s", "12 min", "6 h", "6 h 30 min", "1 d 6 h". Rounds to the
 * displayed unit first, so 59 min 40 s reads "1 h", never "60 min".
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < SECONDS_PER_MINUTE) return `${s} s`;
  const minutes = Math.round(s / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min`;
  if (minutes < MINUTES_PER_DAY) {
    const h = Math.floor(minutes / MINUTES_PER_HOUR);
    const min = minutes % MINUTES_PER_HOUR;
    return min === 0 ? `${h} h` : `${h} h ${min} min`;
  }
  const hours = Math.round(s / SECONDS_PER_HOUR);
  const d = Math.floor(hours / HOURS_PER_DAY);
  const h = hours % HOURS_PER_DAY;
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** Hours [0, 24) as "10:31". */
export function formatHours(hours: number): string {
  const totalMin = Math.round(hours * MINUTES_PER_HOUR) % MINUTES_PER_DAY;
  const hh = String(Math.floor(totalMin / MINUTES_PER_HOUR)).padStart(2, '0');
  return `${hh}:${String(totalMin % MINUTES_PER_HOUR).padStart(2, '0')}`;
}

/** "2027-03-01" */
export const formatDate = (epochS: number): string => iso(epochS).slice(0, 10);

/** UTC hour of day, two digits: "06". */
export const formatHour = (epochS: number): string => iso(epochS).slice(11, 13);
