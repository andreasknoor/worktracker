export type Platform = "windows" | "mac";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  apiKeyHash: string;
  idleThresholdMinutes: number;
  pollIntervalSeconds: number;
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

export interface DevicesRepository {
  create(device: NewDevice): Promise<Device>;
  list(): Promise<Device[]>;
  getById(id: string): Promise<Device | null>;
  getByApiKeyHash(apiKeyHash: string): Promise<Device | null>;
  updateSettings(id: string, update: DeviceSettingsUpdate): Promise<Device | null>;
  touchLastSeen(id: string, atMs: number): Promise<void>;
  revoke(id: string, atMs: number): Promise<boolean>;
}

export interface ActivityEvent {
  deviceId: string;
  timestampMs: number;
}

export interface ActivityEventsRepository {
  insertEvents(deviceId: string, timestampsMs: readonly number[]): Promise<void>;
  /** Events with `timestampMs` in `[startMs, endExclusiveMs)`, for one device. */
  getEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<number[]>;
  /** The earliest recorded event across all devices, or null if none exist. */
  getFirstEventTimestamp(): Promise<number | null>;
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
