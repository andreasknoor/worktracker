import {
  bufferedRangeStart,
  calculateSessions,
  classifyDay,
  effectiveResumeConfirmationWindow,
  mergeSessions,
  mergeSessionsWithDeviceIds,
  splitByDay,
  type AttributedSession,
  type TimeZone,
  type WorkSession,
  type WorkType,
} from "@worktracker/core";
import type { ActivityEventsRepository, Device, DevicesRepository } from "../repositories/types.js";

interface PerDeviceSessions {
  device: Device;
  sessions: WorkSession[];
}

/**
 * Computes each relevant device's own session list for `[startMs,
 * endExclusiveMs)`, using that device's own idle threshold and poll interval
 * (see docs/IMPLEMENTATION_NOTES.md) — the shared first step behind every
 * function below, which differ only in how they filter/combine these
 * per-device lists afterwards. Revoked devices are still included: their
 * historical activity remains valid data.
 */
async function getPerDeviceSessions(
  devicesRepo: DevicesRepository,
  eventsRepo: ActivityEventsRepository,
  startMs: number,
  endExclusiveMs: number,
  deviceId?: string,
): Promise<PerDeviceSessions[]> {
  const allDevices = await devicesRepo.list();
  const devices = deviceId ? allDevices.filter((d) => d.id === deviceId) : allDevices;

  return Promise.all(
    devices.map(async (device) => {
      const idleThresholdMs = device.idleThresholdMinutes * 60_000;
      const resumeConfirmationWindowMs = effectiveResumeConfirmationWindow(device.pollIntervalSeconds * 1000);
      const bufferedStartMs = bufferedRangeStart(startMs, idleThresholdMs);

      const timestamps = await eventsRepo.getEventsInRangeForDevice(device.id, bufferedStartMs, endExclusiveMs);

      return { device, sessions: calculateSessions(timestamps, idleThresholdMs, resumeConfirmationWindowMs) };
    }),
  );
}

/**
 * Restricts each device's sessions to the day-slices classified as
 * `workType` for that device (`classifyDay`, using its own `trackingMode`).
 * Classification happens per device, per calendar day — a device left on
 * "auto" can contribute work time on a weekday and leisure time on the
 * weekend within the very same query range, which a whole-range or
 * whole-day filter can't express.
 */
function filterByWorkType(perDevice: readonly PerDeviceSessions[], timeZone: TimeZone, workType: WorkType): PerDeviceSessions[] {
  return perDevice.map(({ device, sessions }) => {
    const matching = splitByDay(sessions, timeZone)
      .filter((slice) => classifyDay(slice.date, device.trackingMode) === workType)
      .map((slice): WorkSession => ({ start: slice.start, end: slice.end }));
    return { device, sessions: matching };
  });
}

/**
 * The unified timeline across all devices (or one device, with `deviceId`):
 * sessions merged without regard to source or work/leisure classification.
 * This is what every stats endpoint used before either dimension existed,
 * and still what they use when no `?workType=` filter is active.
 */
export async function getMergedSessionsInRange(
  devicesRepo: DevicesRepository,
  eventsRepo: ActivityEventsRepository,
  startMs: number,
  endExclusiveMs: number,
  deviceId?: string,
): Promise<WorkSession[]> {
  const perDevice = await getPerDeviceSessions(devicesRepo, eventsRepo, startMs, endExclusiveMs, deviceId);
  return mergeSessions(perDevice.map((d) => d.sessions));
}

/**
 * Same merge as `getMergedSessionsInRange`, but keeping track of which
 * device(s) contributed to each resulting interval — used to color the
 * aggregated Timeline chart per device (dimension 1: identity). Pass
 * `workType` to scope this to one work/leisure bucket first (dimension 2);
 * omit it (or pass `"all"`) for the full, unfiltered timeline.
 */
export async function getAttributedSessionsInRange(
  devicesRepo: DevicesRepository,
  eventsRepo: ActivityEventsRepository,
  startMs: number,
  endExclusiveMs: number,
  timeZone: TimeZone,
  workType: WorkType | "all" = "all",
  deviceId?: string,
): Promise<AttributedSession[]> {
  let perDevice = await getPerDeviceSessions(devicesRepo, eventsRepo, startMs, endExclusiveMs, deviceId);
  if (workType !== "all") {
    perDevice = filterByWorkType(perDevice, timeZone, workType);
  }
  const sessionsByDevice = new Map(perDevice.map((d) => [d.device.id, d.sessions]));
  return mergeSessionsWithDeviceIds(sessionsByDevice);
}

/**
 * Sessions restricted to a single work/leisure classification (dimension 2),
 * across all relevant devices, without device attribution. Sessions from two
 * devices in the *same* bucket are still deduplicated via the normal
 * overlap-merge; a work-classified device and a leisure-classified device
 * overlapping in time are not merged with each other — they're different
 * categories, and both legitimately count in full toward their own total.
 */
export async function getClassifiedSessionsInRange(
  devicesRepo: DevicesRepository,
  eventsRepo: ActivityEventsRepository,
  startMs: number,
  endExclusiveMs: number,
  timeZone: TimeZone,
  workType: WorkType,
  deviceId?: string,
): Promise<WorkSession[]> {
  const perDevice = filterByWorkType(
    await getPerDeviceSessions(devicesRepo, eventsRepo, startMs, endExclusiveMs, deviceId),
    timeZone,
    workType,
  );
  return mergeSessions(perDevice.map((d) => d.sessions));
}
