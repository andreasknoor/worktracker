import type { StampedEvent, TrackingMode, TrackingModeChange, WorkType } from "@worktracker/core";

export type Platform = "windows" | "mac";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  apiKeyHash: string;
  idleThresholdMinutes: number;
  pollIntervalSeconds: number;
  trackingMode: TrackingMode;
  createdAt: number; // epoch ms
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface NewDevice {
  name: string;
  platform: Platform;
  apiKeyHash: string;
}

export interface DeviceSettingsUpdate {
  idleThresholdMinutes?: number;
  pollIntervalSeconds?: number;
}

/** A device plus the slice of its tracking-mode history relevant to one query range. */
export interface DeviceWithModeHistory extends Device {
  /** Sorted ascending by `effectiveFrom` (ties in insertion order). */
  modeHistory: TrackingModeChange[];
}

export interface DevicesRepository {
  /** Creates the device and its initial tracking-mode history row (`auto`, effective from `createdAt`). */
  create(device: NewDevice): Promise<Device>;
  list(): Promise<Device[]>;
  /**
   * Same devices as `list()`, each with the part of its tracking-mode
   * history needed to classify activity in `[rangeStartMs, endExclusiveMs)`:
   * every change before `endExclusiveMs`, starting at the one in effect at
   * the device's own buffered range start (`rangeStartMs` minus its idle
   * threshold — see `bufferedRangeStart`). The device's first-ever row is
   * always included, even if it lies after the range, since activity that
   * predates all history is classified with the oldest known mode. Fetched together with the device
   * list rather than as a separate query, to keep database round trips flat
   * (docs/PLAN_TRACKER_MODE_TOGGLE.md, "Neon load budget").
   */
  listWithTrackingModeHistory(rangeStartMs: number, endExclusiveMs: number): Promise<DeviceWithModeHistory[]>;
  getById(id: string): Promise<Device | null>;
  getByApiKeyHash(apiKeyHash: string): Promise<Device | null>;
  updateSettings(id: string, update: DeviceSettingsUpdate): Promise<Device | null>;
  /**
   * Sets the device's current tracking mode and, only if it actually
   * changed, appends a history row effective from `atMs` — atomically, so
   * `devices.tracking_mode` and the history can't drift apart. Returns
   * null for an unknown device.
   */
  setTrackingMode(id: string, mode: TrackingMode, atMs: number): Promise<Device | null>;
  /** The tracking-mode change currently in effect for the device (its latest history row), or null. */
  getCurrentTrackingModeChange(id: string): Promise<TrackingModeChange | null>;
  touchLastSeen(id: string, atMs: number): Promise<void>;
  revoke(id: string, atMs: number): Promise<boolean>;
  /**
   * Undoes a `revoke` by clearing `revokedAt`. Safe because revoking only
   * ever sets that one column — the API key hash is untouched, so the
   * device's existing key starts working again immediately and the tracker
   * needs no reconfiguration.
   */
  restore(id: string): Promise<boolean>;
  /**
   * Hard-deletes the device row itself (as opposed to `revoke`'s soft
   * revoke), together with its tracking-mode history. Callers must
   * `orphanEventsForDevice` first — this does not touch `activity_events`.
   */
  delete(id: string): Promise<boolean>;
}

export interface ActivityEvent {
  deviceId: string | null;
  timestampMs: number;
}

export interface ActivityEventsRepository {
  /**
   * `workType` is what the tracker stamped on the whole batch: `"work"` /
   * `"leisure"` as chosen in its menu, or `null` for "as defined on the
   * server" (the device's tracking mode decides). Re-inserting an existing
   * `(deviceId, timestamp)` is a no-op and keeps the stored work type.
   */
  insertEvents(deviceId: string, timestampsMs: readonly number[], workType?: WorkType | null): Promise<void>;
  /** Events with `timestampMs` in `[startMs, endExclusiveMs)`, for one device. */
  getEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<number[]>;
  /**
   * Same range as `getEventsInRangeForDevice`, sorted ascending, together with
   * each event's stamped work type — only loaded when classifying.
   */
  getStampedEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<StampedEvent[]>;
  /** The earliest recorded event, optionally scoped to one device, or null if none exist. */
  getFirstEventTimestamp(deviceId?: string): Promise<number | null>;
  /**
   * Detaches all of a device's events from it (`device_id` -> null) instead
   * of deleting them, so a permanently-deleted device's historical activity
   * survives the device row. Call before `DevicesRepository.delete`.
   */
  orphanEventsForDevice(deviceId: string): Promise<void>;
  /** Events with no device (see `orphanEventsForDevice`) in `[startMs, endExclusiveMs)`. */
  getOrphanedEventsInRange(startMs: number, endExclusiveMs: number): Promise<number[]>;
  /** Same as `getOrphanedEventsInRange`, together with each event's stamped work type. */
  getStampedOrphanedEventsInRange(startMs: number, endExclusiveMs: number): Promise<StampedEvent[]>;
}

export interface GlobalSettings {
  coreHoursStart: string; // "HH:mm"
  coreHoursEnd: string; // "HH:mm"
  /** Hours since a device's `lastSeenAt` before the dashboard's health banner warns about it. */
  deviceStaleThresholdHours: number;
  /** The work-time target for a full calendar week, used by the dashboard's weekly-target/balance card. */
  weeklyTargetHours: number;
  /**
   * How many complete previous weeks the "carried balance" tile sums over.
   * Deliberately a rolling window rather than a fixed start date — avoids
   * needing to pick (and store) an arbitrary "balance tracking began here"
   * date; see docs/IMPLEMENTATION_NOTES.md.
   */
  balanceWindowWeeks: number;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  coreHoursStart: "09:00",
  coreHoursEnd: "18:00",
  deviceStaleThresholdHours: 24,
  weeklyTargetHours: 40,
  balanceWindowWeeks: 8,
};

export interface SettingsRepository {
  get(): Promise<GlobalSettings>;
  save(settings: GlobalSettings): Promise<GlobalSettings>;
}
