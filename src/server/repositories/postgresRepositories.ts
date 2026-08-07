import type { Pool } from "pg";
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
           poll_interval_seconds = COALESCE($3, poll_interval_seconds)
       WHERE id = $1
       RETURNING *`,
      [id, update.idleThresholdMinutes ?? null, update.pollIntervalSeconds ?? null],
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
}

export class PostgresActivityEventsRepository implements ActivityEventsRepository {
  constructor(private readonly pool: Pool) {}

  async insertEvents(deviceId: string, timestampsMs: readonly number[]): Promise<void> {
    if (timestampsMs.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    timestampsMs.forEach((ts, i) => {
      values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
      params.push(deviceId, new Date(ts));
    });

    await this.pool.query(`INSERT INTO activity_events (device_id, timestamp_utc) VALUES ${values.join(", ")}`, params);
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

  async getFirstEventTimestamp(): Promise<number | null> {
    const result = await this.pool.query<{ timestamp_utc: Date | null }>(
      `SELECT MIN(timestamp_utc) AS timestamp_utc FROM activity_events`,
    );
    const value = result.rows[0]?.timestamp_utc;
    return value ? value.getTime() : null;
  }
}

export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<GlobalSettings> {
    const result = await this.pool.query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
    const stored = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    return {
      coreHoursStart: stored["CoreHoursStart"] ?? DEFAULT_GLOBAL_SETTINGS.coreHoursStart,
      coreHoursEnd: stored["CoreHoursEnd"] ?? DEFAULT_GLOBAL_SETTINGS.coreHoursEnd,
    };
  }

  async save(settings: GlobalSettings): Promise<GlobalSettings> {
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ('CoreHoursStart', $1), ('CoreHoursEnd', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [settings.coreHoursStart, settings.coreHoursEnd],
    );
    return settings;
  }
}
