import { addDays, dateKeyInZone, daysBetween, startOfDayUtcMs, type DateKey, type TimeZone } from "./time.js";
import type { Timestamp, WorkSession } from "./types.js";

export interface DailyHours {
  date: DateKey;
  workedTimeMs: number;
}

export interface TimeSegment {
  startMinutes: number;
  endMinutes: number;
}

export interface DailySegments {
  date: DateKey;
  segments: TimeSegment[];
}

export interface PeriodSummary {
  totalWorkedTimeMs: number;
  activeDayCount: number;
  averageWorkedTimePerActiveDayMs: number;
  longestSessionMs: number;
}

export interface LiveView {
  isActive: boolean;
  todayWorkedTimeMs: number;
  currentSessionMs: number;
}

/**
 * Splits each session's duration proportionally across the calendar days
 * (in `timeZone`) it touches, clipped to each day's own [00:00, 24:00) range.
 * See SESSION_LOGIC_SPEC.md "Derived aggregation logic".
 */
export function dailyHours(
  sessions: readonly WorkSession[],
  startKey: DateKey,
  endExclusiveKey: DateKey,
  timeZone: TimeZone,
): DailyHours[] {
  const days = daysBetween(startKey, endExclusiveKey);
  const result: DailyHours[] = days.map((date) => ({ date, workedTimeMs: 0 }));
  const indexByDate = new Map(result.map((r, i) => [r.date, i]));

  const rangeStartMs = startOfDayUtcMs(startKey, timeZone);
  const rangeEndMs = startOfDayUtcMs(endExclusiveKey, timeZone);

  for (const session of sessions) {
    forEachDaySlice(session, rangeStartMs, rangeEndMs, timeZone, (dayKey, sliceStart, sliceEnd) => {
      const idx = indexByDate.get(dayKey);
      if (idx !== undefined) {
        result[idx]!.workedTimeMs += sliceEnd - sliceStart;
      }
    });
  }

  return result;
}

/**
 * Same midnight-splitting idea as `dailyHours`, but produces per-day
 * clock-time segments (minutes since local midnight) instead of totals.
 */
export function dailySegments(
  sessions: readonly WorkSession[],
  startKey: DateKey,
  endExclusiveKey: DateKey,
  timeZone: TimeZone,
): DailySegments[] {
  const days = daysBetween(startKey, endExclusiveKey);
  const result: DailySegments[] = days.map((date) => ({ date, segments: [] }));
  const indexByDate = new Map(result.map((r, i) => [r.date, i]));

  const rangeStartMs = startOfDayUtcMs(startKey, timeZone);
  const rangeEndMs = startOfDayUtcMs(endExclusiveKey, timeZone);

  for (const session of sessions) {
    forEachDaySlice(session, rangeStartMs, rangeEndMs, timeZone, (dayKey, sliceStart, sliceEnd, dayStart) => {
      const idx = indexByDate.get(dayKey);
      if (idx !== undefined) {
        result[idx]!.segments.push({
          startMinutes: (sliceStart - dayStart) / 60_000,
          endMinutes: (sliceEnd - dayStart) / 60_000,
        });
      }
    });
  }

  return result;
}

/** Walks the portion of `session` inside `[rangeStartMs, rangeEndMs)`, one day-slice at a time. */
function forEachDaySlice(
  session: WorkSession,
  rangeStartMs: Timestamp,
  rangeEndMs: Timestamp,
  timeZone: TimeZone,
  onSlice: (dayKey: DateKey, sliceStart: Timestamp, sliceEnd: Timestamp, dayStart: Timestamp) => void,
): void {
  const clampedStart = Math.max(session.start, rangeStartMs);
  const clampedEnd = Math.min(session.end, rangeEndMs);
  if (clampedEnd <= clampedStart) {
    return;
  }

  let cursor = clampedStart;
  while (cursor < clampedEnd) {
    const dayKey = dateKeyInZone(cursor, timeZone);
    const dayStart = startOfDayUtcMs(dayKey, timeZone);
    const nextDayStart = startOfDayUtcMs(addDays(dayKey, 1), timeZone);
    const sliceEnd = Math.min(clampedEnd, nextDayStart);

    onSlice(dayKey, cursor, sliceEnd, dayStart);
    cursor = sliceEnd;
  }
}

/**
 * Aggregates sessions and their daily totals into period-level stats.
 * `longestSessionMs` considers all given sessions, not just those inside the range.
 */
export function summary(sessions: readonly WorkSession[], daily: readonly DailyHours[]): PeriodSummary {
  const totalWorkedTimeMs = daily.reduce((sum, d) => sum + d.workedTimeMs, 0);
  const activeDayCount = daily.filter((d) => d.workedTimeMs > 0).length;
  const averageWorkedTimePerActiveDayMs = activeDayCount > 0 ? totalWorkedTimeMs / activeDayCount : 0;
  const longestSessionMs = sessions.reduce((max, s) => Math.max(max, s.end - s.start), 0);

  return { totalWorkedTimeMs, activeDayCount, averageWorkedTimePerActiveDayMs, longestSessionMs };
}

/**
 * "How much have I worked today" for a live-updating dashboard. If the most
 * recent session's end is still within `idleThreshold` of `nowMs`, that
 * session is treated as still running and extended to `nowMs` before
 * computing today's total and the current session's duration.
 */
export function liveView(
  sessions: readonly WorkSession[],
  nowMs: Timestamp,
  idleThreshold: number,
  timeZone: TimeZone,
): LiveView {
  if (sessions.length === 0) {
    return { isActive: false, todayWorkedTimeMs: 0, currentSessionMs: 0 };
  }

  const last = sessions[sessions.length - 1]!;
  const isActive = nowMs - last.end <= idleThreshold;
  const effectiveSessions = isActive ? [...sessions.slice(0, -1), { start: last.start, end: nowMs }] : sessions;

  const todayKey = dateKeyInZone(nowMs, timeZone);
  const [today] = dailyHours(effectiveSessions, todayKey, addDays(todayKey, 1), timeZone);
  const currentSessionMs = isActive ? nowMs - last.start : 0;

  return { isActive, todayWorkedTimeMs: today?.workedTimeMs ?? 0, currentSessionMs };
}

/**
 * When loading events for a range query `[start, endExclusive)`, fetch
 * events starting `idleThreshold` before `start` so a session that began
 * just before the boundary isn't truncated/restarted at the boundary. See
 * SESSION_LOGIC_SPEC.md "Range-query buffering".
 */
export function bufferedRangeStart(startMs: Timestamp, idleThreshold: number): Timestamp {
  return startMs - idleThreshold;
}
