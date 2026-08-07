import {
  bufferedRangeStart,
  calculateSessions,
  effectiveResumeConfirmationWindow,
  mergeSessions,
  type WorkSession,
} from "@worktracker/core";
import type { ActivityEventsRepository, DevicesRepository } from "../repositories/types.js";

/**
 * Computes the work-session timeline for `[startMs, endExclusiveMs)`. With
 * no `deviceId`, this is the unified timeline across all devices: each
 * device can have its own idle threshold and poll interval (see
 * docs/IMPLEMENTATION_NOTES.md), so sessions are calculated per device first
 * — using that device's own settings and its own buffered range fetch — and
 * only merged into one timeline afterwards. Revoked devices are still
 * included: their historical activity remains valid data. With a `deviceId`,
 * only that one device's sessions are computed (no merging needed).
 */
export async function getMergedSessionsInRange(
  devicesRepo: DevicesRepository,
  eventsRepo: ActivityEventsRepository,
  startMs: number,
  endExclusiveMs: number,
  deviceId?: string,
): Promise<WorkSession[]> {
  const allDevices = await devicesRepo.list();
  const devices = deviceId ? allDevices.filter((d) => d.id === deviceId) : allDevices;

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
