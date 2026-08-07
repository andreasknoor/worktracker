import {
  bufferedRangeStart,
  calculateSessions,
  effectiveResumeConfirmationWindow,
  mergeSessions,
  type WorkSession,
} from "@worktracker/core";
import type { ActivityEventsRepository, DevicesRepository } from "../repositories/types.js";

/**
 * Computes the unified work-session timeline for `[startMs, endExclusiveMs)`
 * across all devices. Each device can have its own idle threshold and poll
 * interval (see docs/IMPLEMENTATION_NOTES.md), so sessions are calculated
 * per device first — using that device's own settings and its own buffered
 * range fetch — and only merged into one timeline afterwards. Revoked
 * devices are still included: their historical activity remains valid data.
 */
export async function getMergedSessionsInRange(
  devicesRepo: DevicesRepository,
  eventsRepo: ActivityEventsRepository,
  startMs: number,
  endExclusiveMs: number,
): Promise<WorkSession[]> {
  const devices = await devicesRepo.list();

  const perDeviceSessions = await Promise.all(
    devices.map(async (device) => {
      const idleThresholdMs = device.idleThresholdMinutes * 60_000;
      const resumeConfirmationWindowMs = effectiveResumeConfirmationWindow(device.pollIntervalSeconds * 1000);
      const bufferedStartMs = bufferedRangeStart(startMs, idleThresholdMs);

      const timestamps = await eventsRepo.getEventsInRangeForDevice(device.id, bufferedStartMs, endExclusiveMs);

      return calculateSessions(timestamps, idleThresholdMs, resumeConfirmationWindowMs);
    }),
  );

  return mergeSessions(perDeviceSessions);
}
