import { randomUUID } from "node:crypto";
import type {
  ActivityEventsRepository,
  Device,
  DeviceSettingsUpdate,
  DevicesRepository,
  GlobalSettings,
  NewDevice,
  SettingsRepository,
} from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

export class InMemoryDevicesRepository implements DevicesRepository {
  private readonly devices = new Map<string, Device>();

  async create(device: NewDevice): Promise<Device> {
    const created: Device = {
      id: randomUUID(),
      name: device.name,
      platform: device.platform,
      apiKeyHash: device.apiKeyHash,
      idleThresholdMinutes: 30,
      pollIntervalSeconds: 30,
      trackingMode: "auto",
      createdAt: Date.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(created.id, created);
    return created;
  }

  async list(): Promise<Device[]> {
    return [...this.devices.values()];
  }

  async getById(id: string): Promise<Device | null> {
    return this.devices.get(id) ?? null;
  }

  async getByApiKeyHash(apiKeyHash: string): Promise<Device | null> {
    for (const device of this.devices.values()) {
      if (device.apiKeyHash === apiKeyHash) return device;
    }
    return null;
  }

  async updateSettings(id: string, update: DeviceSettingsUpdate): Promise<Device | null> {
    const device = this.devices.get(id);
    if (!device) return null;
    const updated: Device = {
      ...device,
      idleThresholdMinutes: update.idleThresholdMinutes ?? device.idleThresholdMinutes,
      pollIntervalSeconds: update.pollIntervalSeconds ?? device.pollIntervalSeconds,
      trackingMode: update.trackingMode ?? device.trackingMode,
    };
    this.devices.set(id, updated);
    return updated;
  }

  async touchLastSeen(id: string, atMs: number): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    this.devices.set(id, { ...device, lastSeenAt: atMs });
  }

  async revoke(id: string, atMs: number): Promise<boolean> {
    const device = this.devices.get(id);
    if (!device) return false;
    this.devices.set(id, { ...device, revokedAt: atMs });
    return true;
  }
}

export class InMemoryActivityEventsRepository implements ActivityEventsRepository {
  private readonly events: { deviceId: string; timestampMs: number }[] = [];

  async insertEvents(deviceId: string, timestampsMs: readonly number[]): Promise<void> {
    for (const timestampMs of timestampsMs) {
      this.events.push({ deviceId, timestampMs });
    }
  }

  async getEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<number[]> {
    return this.events
      .filter((e) => e.deviceId === deviceId && e.timestampMs >= startMs && e.timestampMs < endExclusiveMs)
      .map((e) => e.timestampMs)
      .sort((a, b) => a - b);
  }

  async getFirstEventTimestamp(deviceId?: string): Promise<number | null> {
    const scoped = deviceId ? this.events.filter((e) => e.deviceId === deviceId) : this.events;
    if (scoped.length === 0) return null;
    return Math.min(...scoped.map((e) => e.timestampMs));
  }
}

export class InMemorySettingsRepository implements SettingsRepository {
  private settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };

  async get(): Promise<GlobalSettings> {
    return this.settings;
  }

  async save(settings: GlobalSettings): Promise<GlobalSettings> {
    this.settings = settings;
    return this.settings;
  }
}
