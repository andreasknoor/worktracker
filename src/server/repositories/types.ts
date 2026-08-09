import type { TrackingMode } from "@worktracker/core";

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
  trackingMode?: TrackingMode;
}

export interface DevicesRepository {
  create(device: NewDevice): Promise<Device>;
  list(): Promise<Device[]>;
  getById(id: string): Promise<Device | null>;
  getByApiKeyHash(apiKeyHash: string): Promise<Device | null>;
  updateSettings(id: string, update: DeviceSettingsUpdate): Promise<Device | null>;
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
   * revoke). Callers must `orphanEventsForDevice` first — this does not
   * touch `activity_events`.
   */
  delete(id: string): Promise<boolean>;
}

export interface ActivityEvent {
  deviceId: string | null;
  timestampMs: number;
}

export interface ActivityEventsRepository {
  insertEvents(deviceId: string, timestampsMs: readonly number[]): Promise<void>;
  /** Events with `timestampMs` in `[startMs, endExclusiveMs)`, for one device. */
  getEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<number[]>;
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
}

export interface GlobalSettings {
  coreHoursStart: string; // "HH:mm"
  coreHoursEnd: string; // "HH:mm"
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  coreHoursStart: "09:00",
  coreHoursEnd: "18:00",
};

export interface SettingsRepository {
  get(): Promise<GlobalSettings>;
  save(settings: GlobalSettings): Promise<GlobalSettings>;
}
