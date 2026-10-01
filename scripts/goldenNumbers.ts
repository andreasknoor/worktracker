// Offline acceptance check for changes to work/leisure classification (see
// docs/PLAN_TRACKER_MODE_TOGGLE.md, risk R3): recomputes per-day hours for
// the full history twice — once with a frozen copy of the original v1.21
// classification (`classifyDay` against each device's *current*
// trackingMode), once through the live service code — and reports every day
// where they differ. Runs entirely on a local database export, so the check
// costs one read of each table instead of repeated full-history stats
// requests against Neon. The CLI wrapper is scripts/golden-numbers.ts.
import {
  addDays,
  bufferedRangeStart,
  calculateSessions,
  classifyDay,
  dailyHours,
  dateKeyInZone,
  effectiveResumeConfirmationWindow,
  mergeSessions,
  splitByDay,
  type DateKey,
  type TimeZone,
  type TrackingMode,
  type WorkSession,
  type WorkType,
} from "@worktracker/core";
import type { Device, Platform } from "../src/server/repositories/types.js";
import {
  InMemoryActivityEventsRepository,
  InMemoryDevicesRepository,
} from "../src/server/repositories/memoryRepositories.js";
import { getClassifiedSessionsInRange, getMergedSessionsInRange } from "../src/server/services/sessionsService.js";

/** Key under which events with `device_id IS NULL` (orphaned) are stored in an export. */
export const ORPHANED_EVENTS_KEY = "__orphaned__";

export interface ExportedDevice {
  id: string;
  name: string;
  platform: Platform;
  idleThresholdMinutes: number;
  pollIntervalSeconds: number;
  trackingMode: TrackingMode;
  createdAt: number;
  revokedAt: number | null;
}

export interface ExportedModeChange {
  deviceId: string;
  trackingMode: TrackingMode;
  effectiveFrom: number;
}

export interface GoldenExport {
  exportedAt: string;
  devices: ExportedDevice[];
  /** Event timestamps (epoch ms) by device id, plus `ORPHANED_EVENTS_KEY`. */
  events: Record<string, number[]>;
  /** `device_tracking_mode_history` rows, or null if the table didn't exist yet. */
  trackingModeHistory: ExportedModeChange[] | null;
}

export interface Mismatch {
  workType: WorkType | "all";
  date: DateKey;
  expectedMs: number;
  actualMs: number;
}

export interface GoldenResult {
  rangeStart: DateKey | null;
  rangeEndExclusive: DateKey | null;
  daysCompared: number;
  mismatches: Mismatch[];
}

// Same fallbacks as ORPHANED_* in src/server/services/sessionsService.ts.
const ORPHANED_IDLE_THRESHOLD_MINUTES = 30;
const ORPHANED_POLL_INTERVAL_SECONDS = 30;

export function loadIntoRepositories(data: GoldenExport): {
  devices: InMemoryDevicesRepository;
  events: InMemoryActivityEventsRepository;
} {
  const devices = new InMemoryDevicesRepository();
  const events = new InMemoryActivityEventsRepository();
  for (const d of data.devices) {
    const device: Device = { ...d, apiKeyHash: "", lastSeenAt: null };
    devices.seedDevice(device);
  }
  for (const [key, timestamps] of Object.entries(data.events)) {
    events.seedEvents(key === ORPHANED_EVENTS_KEY ? null : key, timestamps);
  }
  for (const change of data.trackingModeHistory ?? []) {
    devices.seedTrackingModeChange(change.deviceId, change.trackingMode, change.effectiveFrom);
  }
  return { devices, events };
}

/** The v1.21 classification, frozen: every slice classified by the device's current mode. */
function referenceSessions(
  data: GoldenExport,
  startMs: number,
  endExclusiveMs: number,
  timeZone: TimeZone,
  workType: WorkType | "all",
): WorkSession[] {
  const perDevice: { trackingMode: TrackingMode; sessions: WorkSession[] }[] = [];

  const sessionsFor = (timestamps: readonly number[], idleMinutes: number, pollSeconds: number) => {
    const idleMs = idleMinutes * 60_000;
    const from = bufferedRangeStart(startMs, idleMs);
    const inRange = timestamps.filter((t) => t >= from && t < endExclusiveMs);
    return calculateSessions(inRange, idleMs, effectiveResumeConfirmationWindow(pollSeconds * 1000));
  };

  for (const d of data.devices) {
    perDevice.push({
      trackingMode: d.trackingMode,
      sessions: sessionsFor(data.events[d.id] ?? [], d.idleThresholdMinutes, d.pollIntervalSeconds),
    });
  }
  const orphaned = data.events[ORPHANED_EVENTS_KEY] ?? [];
  if (orphaned.length > 0) {
    perDevice.push({
      trackingMode: "auto",
      sessions: sessionsFor(orphaned, ORPHANED_IDLE_THRESHOLD_MINUTES, ORPHANED_POLL_INTERVAL_SECONDS),
    });
  }

  if (workType === "all") return mergeSessions(perDevice.map((d) => d.sessions));
  return mergeSessions(
    perDevice.map(({ trackingMode, sessions }) =>
      splitByDay(sessions, timeZone)
        .filter((slice) => classifyDay(slice.date, trackingMode) === workType)
        .map(({ start, end }) => ({ start, end })),
    ),
  );
}

export async function compareGoldenNumbers(data: GoldenExport, timeZone: TimeZone, nowMs: number): Promise<GoldenResult> {
  const allTimestamps = Object.values(data.events).flat();
  if (allTimestamps.length === 0) {
    return { rangeStart: null, rangeEndExclusive: null, daysCompared: 0, mismatches: [] };
  }

  const firstMs = allTimestamps.reduce((min, t) => Math.min(min, t), Infinity);
  // One day of margin on both sides: stats ranges are UTC-midnight aligned,
  // while day buckets are APP_TIME_ZONE days.
  const start = addDays(dateKeyInZone(firstMs, timeZone), -1);
  const endExclusive = addDays(dateKeyInZone(nowMs, timeZone), 2);
  const startMs = Date.parse(start + "T00:00:00Z");
  const endExclusiveMs = Date.parse(endExclusive + "T00:00:00Z");

  const repos = loadIntoRepositories(data);
  const mismatches: Mismatch[] = [];
  let daysCompared = 0;

  for (const workType of ["all", "work", "leisure"] as const) {
    const expected = dailyHours(referenceSessions(data, startMs, endExclusiveMs, timeZone, workType), start, endExclusive, timeZone);
    const actualSessions =
      workType === "all"
        ? await getMergedSessionsInRange(repos.devices, repos.events, startMs, endExclusiveMs)
        : await getClassifiedSessionsInRange(repos.devices, repos.events, startMs, endExclusiveMs, timeZone, workType);
    const actual = dailyHours(actualSessions, start, endExclusive, timeZone);

    expected.forEach((day, i) => {
      daysCompared += 1;
      const actualMs = actual[i]?.workedTimeMs ?? 0;
      if (actualMs !== day.workedTimeMs) {
        mismatches.push({ workType, date: day.date, expectedMs: day.workedTimeMs, actualMs });
      }
    });
  }

  return { rangeStart: start, rangeEndExclusive: endExclusive, daysCompared, mismatches };
}
