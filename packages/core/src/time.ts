import type { Timestamp, TrackingMode, WorkType } from "./types.js";

/** IANA time zone identifier, e.g. "Europe/Berlin". */
export type TimeZone = string;

/** Calendar date key in "yyyy-MM-dd" form. */
export type DateKey = string;

function zonedComponents(epochMs: number, timeZone: TimeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // hourCycle h23 can still emit "24" for midnight in some environments
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's offset from UTC (in ms) at the given instant: localTime = utcTime + offset. */
function offsetMsAt(epochMs: number, timeZone: TimeZone): number {
  const c = zonedComponents(epochMs, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - epochMs;
}

/** The "yyyy-MM-dd" calendar date that `epochMs` falls on in `timeZone`. */
export function dateKeyInZone(epochMs: Timestamp, timeZone: TimeZone): DateKey {
  const c = zonedComponents(epochMs, timeZone);
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

/** Epoch ms of local midnight (00:00) for `dateKey` in `timeZone`. */
export function startOfDayUtcMs(dateKey: DateKey, timeZone: TimeZone): Timestamp {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // One correction pass is enough except exactly at a DST transition instant,
  // which is an acceptable edge case for day-boundary purposes here.
  const offset = offsetMsAt(guess, timeZone);
  return guess - offset;
}

/** Adds `days` calendar days to a "yyyy-MM-dd" key (pure calendar arithmetic, zone-independent). */
export function addDays(dateKey: DateKey, days: number): DateKey {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** Enumerates "yyyy-MM-dd" keys in `[startKey, endExclusiveKey)`. */
export function daysBetween(startKey: DateKey, endExclusiveKey: DateKey): DateKey[] {
  const [sy, sm, sd] = startKey.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = endExclusiveKey.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  const keys: DateKey[] = [];
  for (let t = start; t < end; t += 86_400_000) {
    keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

/** Minutes since local midnight (in `timeZone`) for `epochMs`, typically in `[0, 1440)`. */
export function minutesSinceMidnight(epochMs: Timestamp, timeZone: TimeZone): number {
  const dayStart = startOfDayUtcMs(dateKeyInZone(epochMs, timeZone), timeZone);
  return (epochMs - dayStart) / 60_000;
}

/** Formats `epochMs` as a local "HH:mm" 24h clock string in `timeZone`. */
export function formatHHmm(epochMs: Timestamp, timeZone: TimeZone): string {
  const c = zonedComponents(epochMs, timeZone);
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** First day of the calendar month (UTC-calendar, zone-independent) containing `dateKey`. */
export function monthStart(dateKey: DateKey): DateKey {
  const [y, m] = dateKey.split("-").map(Number) as [number, number];
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Exclusive end of the calendar month containing `dateKey` (first day of the next month). */
export function monthEndExclusive(dateKey: DateKey): DateKey {
  const [y, m] = dateKey.split("-").map(Number) as [number, number];
  const t = Date.UTC(y, m, 1); // JS Date months are 0-indexed, so `m` here is already "next month"
  return new Date(t).toISOString().slice(0, 10);
}

/** The Monday on or before `dateKey` (UTC-calendar week arithmetic). */
export function mondayOnOrBefore(dateKey: DateKey): DateKey {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dateKey, diff);
}

/** True if `dateKey` falls on a Saturday or Sunday (UTC-calendar weekday arithmetic). */
export function isWeekend(dateKey: DateKey): boolean {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
  return weekday === 0 || weekday === 6;
}

/**
 * Classifies a calendar day as work or leisure time for a device with the
 * given tracking mode. `auto` follows the default rule (Mon-Fri = work,
 * Sat-Sun = leisure); `alwaysWork`/`alwaysLeisure` override it regardless of
 * the day of week.
 */
export function classifyDay(dateKey: DateKey, trackingMode: TrackingMode): WorkType {
  if (trackingMode === "alwaysWork") return "work";
  if (trackingMode === "alwaysLeisure") return "leisure";
  return isWeekend(dateKey) ? "leisure" : "work";
}
