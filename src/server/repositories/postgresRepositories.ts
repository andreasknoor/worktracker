import type { Pool } from "pg";
import type { TrackingMode } from "@worktracker/core";
import type {
  ActivityEventsRepository,
  Device,
  DeviceSettingsUpdate,
  DevicesRepository,
  GlobalSettings,
  NewDevice,
  Platform,
  SettingsRepository,
} from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

interface DeviceRow {
  id: string;
  name: string;
  platform: Platform;
  api_key_hash: string;
  idle_threshold_minutes: number;
  poll_interval_seconds: number;
  tracking_mode: TrackingMode;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    apiKeyHash: row.api_key_hash,
    idleThresholdMinutes: row.idle_threshold_minutes,
    pollIntervalSeconds: row.poll_interval_seconds,
    trackingMode: row.tracking_mode,
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at?.getTime() ?? null,
    revokedAt: row.revoked_at?.getTime() ?? null,
  };
}

export class PostgresDevicesRepository implements DevicesRepository {
  constructor(private readonly pool: Pool) {}

  async create(device: NewDevice): Promise<Device> {
    const result = await this.pool.query<DeviceRow>(
      `INSERT INTO devices (name, platform, api_key_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [device.name, device.platform, device.apiKeyHash],
    );
    return toDevice(result.rows[0]!);
  }

  async list(): Promise<Device[]> {
    const result = await this.pool.query<DeviceRow>(`SELECT * FROM devices ORDER BY created_at ASC`);
    return result.rows.map(toDevice);
  }

  async getById(id: string): Promise<Device | null> {
    const result = await this.pool.query<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [id]);
    return result.rows[0] ? toDevice(result.rows[0]) : null;
  }

  async getByApiKeyHash(apiKeyHash: string): Promise<Device | null> {
    const result = await this.pool.query<DeviceRow>(`SELECT * FROM devices WHERE api_key_hash = $1`, [apiKeyHash]);
    return result.rows[0] ? toDevice(result.rows[0]) : null;
  }

  async updateSettings(id: string, update: DeviceSettingsUpdate): Promise<Device | null> {
    const result = await this.pool.query<DeviceRow>(
      `UPDATE devices
       SET idle_threshold_minutes = COALESCE($2, idle_threshold_minutes),
           poll_interval_seconds = COALESCE($3, poll_interval_seconds),
           tracking_mode = COALESCE($4, tracking_mode)
       WHERE id = $1
       RETURNING *`,
      [id, update.idleThresholdMinutes ?? null, update.pollIntervalSeconds ?? null, update.trackingMode ?? null],
    );
    return result.rows[0] ? toDevice(result.rows[0]) : null;
  }

  async touchLastSeen(id: string, atMs: number): Promise<void> {
    await this.pool.query(`UPDATE devices SET last_seen_at = $2 WHERE id = $1`, [id, new Date(atMs)]);
  }

  async revoke(id: string, atMs: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE devices SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [
      id,
      new Date(atMs),
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async restore(id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE devices SET revoked_at = NULL WHERE id = $1 AND revoked_at IS NOT NULL`, [
      id,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM devices WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

// Keeps each INSERT well under Postgres's ~65535-bind-parameter limit
// (2 params/row) regardless of how large a batch the caller passes in.
const INSERT_CHUNK_SIZE = 1000;

export class PostgresActivityEventsRepository implements ActivityEventsRepository {
  constructor(private readonly pool: Pool) {}

  async insertEvents(deviceId: string, timestampsMs: readonly number[]): Promise<void> {
    for (let offset = 0; offset < timestampsMs.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = timestampsMs.slice(offset, offset + INSERT_CHUNK_SIZE);

      const values: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((ts, i) => {
        values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
        params.push(deviceId, new Date(ts));
      });

      await this.pool.query(
        `INSERT INTO activity_events (device_id, timestamp_utc) VALUES ${values.join(", ")}`,
        params,
      );
    }
  }

  async getEventsInRangeForDevice(deviceId: string, startMs: number, endExclusiveMs: number): Promise<number[]> {
    const result = await this.pool.query<{ timestamp_utc: Date }>(
      `SELECT timestamp_utc FROM activity_events
       WHERE device_id = $1 AND timestamp_utc >= $2 AND timestamp_utc < $3
       ORDER BY timestamp_utc ASC`,
      [deviceId, new Date(startMs), new Date(endExclusiveMs)],
    );
    return result.rows.map((r) => r.timestamp_utc.getTime());
  }

  async getFirstEventTimestamp(deviceId?: string): Promise<number | null> {
    const result = await this.pool.query<{ timestamp_utc: Date | null }>(
      deviceId
        ? `SELECT MIN(timestamp_utc) AS timestamp_utc FROM activity_events WHERE device_id = $1`
        : `SELECT MIN(timestamp_utc) AS timestamp_utc FROM activity_events`,
      deviceId ? [deviceId] : [],
    );
    const value = result.rows[0]?.timestamp_utc;
    return value ? value.getTime() : null;
  }

  async orphanEventsForDevice(deviceId: string): Promise<void> {
    await this.pool.query(`UPDATE activity_events SET device_id = NULL WHERE device_id = $1`, [deviceId]);
  }

  async getOrphanedEventsInRange(startMs: number, endExclusiveMs: number): Promise<number[]> {
    const result = await this.pool.query<{ timestamp_utc: Date }>(
      `SELECT timestamp_utc FROM activity_events
       WHERE device_id IS NULL AND timestamp_utc >= $1 AND timestamp_utc < $2
       ORDER BY timestamp_utc ASC`,
      [new Date(startMs), new Date(endExclusiveMs)],
    );
    return result.rows.map((r) => r.timestamp_utc.getTime());
  }
}

export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<GlobalSettings> {
    const result = await this.pool.query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
    const stored = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    const staleThreshold = Number(stored["DeviceStaleThresholdHours"]);
    const weeklyTargetHours = Number(stored["WeeklyTargetHours"]);
    const balanceWindowWeeks = Number(stored["BalanceWindowWeeks"]);
    return {
      coreHoursStart: stored["CoreHoursStart"] ?? DEFAULT_GLOBAL_SETTINGS.coreHoursStart,
      coreHoursEnd: stored["CoreHoursEnd"] ?? DEFAULT_GLOBAL_SETTINGS.coreHoursEnd,
      deviceStaleThresholdHours: Number.isFinite(staleThreshold) && staleThreshold > 0
        ? staleThreshold
        : DEFAULT_GLOBAL_SETTINGS.deviceStaleThresholdHours,
      weeklyTargetHours: Number.isFinite(weeklyTargetHours) && weeklyTargetHours > 0
        ? weeklyTargetHours
        : DEFAULT_GLOBAL_SETTINGS.weeklyTargetHours,
      balanceWindowWeeks: Number.isInteger(balanceWindowWeeks) && balanceWindowWeeks > 0
        ? balanceWindowWeeks
        : DEFAULT_GLOBAL_SETTINGS.balanceWindowWeeks,
    };
  }

  async save(settings: GlobalSettings): Promise<GlobalSettings> {
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES
         ('CoreHoursStart', $1), ('CoreHoursEnd', $2), ('DeviceStaleThresholdHours', $3),
         ('WeeklyTargetHours', $4), ('BalanceWindowWeeks', $5)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        settings.coreHoursStart,
        settings.coreHoursEnd,
        String(settings.deviceStaleThresholdHours),
        String(settings.weeklyTargetHours),
        String(settings.balanceWindowWeeks),
      ],
    );
    return settings;
  }
}
