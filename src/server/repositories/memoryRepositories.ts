import { randomUUID } from "node:crypto";
import type { StampedEvent, TrackingMode, TrackingModeChange, WorkType } from "@worktracker/core";
import type {
  ActivityEventsRepository,
  Device,
  DeviceSettingsUpdate,
  DeviceWithModeHistory,
  DevicesRepository,
  GlobalSettings,
  NewDevice,
  SettingsRepository,
} from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

export class InMemoryDevicesRepository implements DevicesRepository {
  private readonly devices = new Map<string, Device>();
  /** Mirrors `device_tracking_mode_history`; array order stands in for the bigserial id (tie-breaker). */
  private readonly modeHistory: { deviceId: string; change: TrackingModeChange }[] = [];

  /** `now` stands in for the database's `now()` default on `created_at`. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Inserts a fully-specified device as-is (fixed id/createdAt, no history row) — for tests and offline tooling. */
  seedDevice(device: Device): void {
    this.devices.set(device.id, { ...device });
  }

  /** Appends a raw history row as-is — for tests and offline tooling. */
  seedTrackingModeChange(deviceId: string, mode: TrackingMode, effectiveFrom: number): void {
    this.modeHistory.push({ deviceId, change: { effectiveFrom, mode } });
  }

  async create(device: NewDevice): Promise<Device> {
    const created: Device = {
      id: randomUUID(),
      name: device.name,
      platform: device.platform,
      apiKeyHash: device.apiKeyHash,
      idleThresholdMinutes: 30,
      pollIntervalSeconds: 30,
      trackingMode: "auto",
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(created.id, created);
    this.modeHistory.push({ deviceId: created.id, change: { effectiveFrom: created.createdAt, mode: created.trackingMode } });
    return created;
  }

  async list(): Promise<Device[]> {
    return [...this.devices.values()];
  }

  async listWithTrackingModeHistory(rangeStartMs: number, endExclusiveMs: number): Promise<DeviceWithModeHistory[]> {
    return [...this.devices.values()].map((device) => {
      const all = this.historyFor(device.id);
      // The first row is always kept (see the Postgres implementation).
      const sorted = all.filter((c, i) => i === 0 || c.effectiveFrom < endExclusiveMs);
      const bufferedStart = rangeStartMs - device.idleThresholdMinutes * 60_000;
      const governing = sorted.filter((c) => c.effectiveFrom <= bufferedStart).at(-1);
      const lowerBound = governing?.effectiveFrom ?? -Infinity;
      return { ...device, modeHistory: sorted.filter((c) => c.effectiveFrom >= lowerBound) };
    });
  }

  async setTrackingMode(id: string, mode: TrackingMode, atMs: number): Promise<Device | null> {
    const device = this.devices.get(id);
    if (!device) return null;
    if (device.trackingMode === mode) return device;
    const updated: Device = { ...device, trackingMode: mode };
    this.devices.set(id, updated);
    this.modeHistory.push({ deviceId: id, change: { effectiveFrom: atMs, mode } });
    return updated;
  }

  async getCurrentTrackingModeChange(id: string): Promise<TrackingModeChange | null> {
    return this.historyFor(id).at(-1) ?? null;
  }

  /** The device's history sorted like `ORDER BY effective_from, id` (sort is stable). */
  private historyFor(deviceId: string): TrackingModeChange[] {
    return this.modeHistory
      .filter((h) => h.deviceId === deviceId)
      .map((h) => ({ ...h.change }))
      .sort((a, b) => a.effectiveFrom - b.effectiveFrom);
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

  async restore(id: string): Promise<boolean> {
    const device = this.devices.get(id);
    if (!device || device.revokedAt === null) return false;
    this.devices.set(id, { ...device, revokedAt: null });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    // Mirrors ON DELETE CASCADE on device_tracking_mode_history.
    for (let i = this.modeHistory.length - 1; i >= 0; i -= 1) {
      if (this.modeHistory[i]!.deviceId === id) this.modeHistory.splice(i, 1);
    }
    return this.devices.delete(id);
  }
}

export class InMemoryActivityEventsRepository implements ActivityEventsRepository {
  private readonly events: { deviceId: string | null; timestampMs: number; workType: WorkType | null }[] = [];

  /**
   * Bulk-loads events without the duplicate check `insertEvents` does
   * (which is quadratic) — for offline tooling loading an already-unique
   * database export. `deviceId: null` loads orphaned events.
   */
  seedEvents(deviceId: string | null, timestampsMs: readonly number[], workType: WorkType | null = null): void {
    for (const timestampMs of timestampsMs) this.events.push({ deviceId, timestampMs, workType });
  }

  async insertEvents(deviceId: string, timestampsMs: readonly number[], workType: WorkType | null = null): Promise<void> {
    for (const timestampMs of timestampsMs) {
      // Mirrors the Postgres unique index on (device_id, timestamp_utc).
      if (this.events.some((e) => e.deviceId === deviceId && e.timestampMs === timestampMs)) continue;
      this.events.push({ deviceId, timestampMs, workType });
    }
  }

  private stampedInRange(deviceId: string | null, startMs: number, endExclusiveMs: number): StampedEvent[] {
    return this.events
      .filter((e) => e.deviceId === deviceId && e.timestampMs >= startMs && e.timestampMs < endExclusiveMs)
      .map((e) => ({ timestamp: e.timestampMs, workType: e.workType }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<number[]> {
    return this.stampedInRange(deviceId, startMs, endExclusiveMs).map((e) => e.timestamp);
  }

  async getStampedEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<StampedEvent[]> {
    return this.stampedInRange(deviceId, startMs, endExclusiveMs);
  }

  async getFirstEventTimestamp(deviceId?: string): Promise<number | null> {
    const scoped = deviceId ? this.events.filter((e) => e.deviceId === deviceId) : this.events;
    if (scoped.length === 0) return null;
    return Math.min(...scoped.map((e) => e.timestampMs));
  }

  async orphanEventsForDevice(deviceId: string): Promise<void> {
    for (const event of this.events) {
      if (event.deviceId === deviceId) event.deviceId = null;
    }
  }

  async getOrphanedEventsInRange(startMs: number, endExclusiveMs: number): Promise<number[]> {
    return this.stampedInRange(null, startMs, endExclusiveMs).map((e) => e.timestamp);
  }

  async getStampedOrphanedEventsInRange(startMs: number, endExclusiveMs: number): Promise<StampedEvent[]> {
    return this.stampedInRange(null, startMs, endExclusiveMs);
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
