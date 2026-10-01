import type { Pool } from "pg";
import type { TrackingMode, TrackingModeChange } from "@worktracker/core";
import type {
  ActivityEventsRepository,
  Device,
  DeviceSettingsUpdate,
  DeviceWithModeHistory,
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
    // One statement, so the device and its initial history row are atomic.
    const result = await this.pool.query<DeviceRow>(
      `WITH created AS (
         INSERT INTO devices (name, platform, api_key_hash)
         VALUES ($1, $2, $3)
         RETURNING *
       ), initial_mode AS (
         INSERT INTO device_tracking_mode_history (device_id, tracking_mode, effective_from)
         SELECT id, tracking_mode, created_at FROM created
       )
       SELECT * FROM created`,
      [device.name, device.platform, device.apiKeyHash],
    );
    return toDevice(result.rows[0]!);
  }

  async list(): Promise<Device[]> {
    const result = await this.pool.query<DeviceRow>(`SELECT * FROM devices ORDER BY created_at ASC`);
    return result.rows.map(toDevice);
  }

  async listWithTrackingModeHistory(rangeStartMs: number, endExclusiveMs: number): Promise<DeviceWithModeHistory[]> {
    // The history is aggregated per device inside the device-list query
    // (no extra round trip), selecting only the two columns classification
    // needs. The lower bound is the change in effect at the device's own
    // buffered range start, which depends on its idle threshold.
    const result = await this.pool.query<DeviceRow & { mode_history: { effectiveFrom: number; mode: TrackingMode }[] }>(
      `SELECT d.*,
         COALESCE((
           SELECT json_agg(
                    json_build_object(
                      'effectiveFrom', round(extract(epoch FROM h.effective_from) * 1000)::bigint,
                      'mode', h.tracking_mode
                    ) ORDER BY h.effective_from, h.id)
           FROM device_tracking_mode_history h
           WHERE h.device_id = d.id
             -- The device's very first row is always included, even after
             -- the range: activity predating all history is classified with
             -- the oldest known mode, not the current one.
             AND (h.effective_from < $2 OR h.id = (
               SELECT f.id FROM device_tracking_mode_history f
               WHERE f.device_id = d.id
               ORDER BY f.effective_from, f.id
               LIMIT 1
             ))
             AND h.effective_from >= COALESCE((
               SELECT max(g.effective_from) FROM device_tracking_mode_history g
               WHERE g.device_id = d.id
                 AND g.effective_from <= $1::timestamptz - make_interval(mins => d.idle_threshold_minutes)
             ), '-infinity'::timestamptz)
         ), '[]'::json) AS mode_history
       FROM devices d
       ORDER BY d.created_at ASC`,
      [new Date(rangeStartMs), new Date(endExclusiveMs)],
    );
    return result.rows.map((row) => ({
      ...toDevice(row),
      modeHistory: row.mode_history.map((c) => ({ effectiveFrom: Number(c.effectiveFrom), mode: c.mode })),
    }));
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

  async setTrackingMode(id: string, mode: TrackingMode, atMs: number): Promise<Device | null> {
    // A single statement is atomic without an explicit transaction (and
    // costs one round trip instead of four). `FOR UPDATE` serializes
    // concurrent switches of the same device; the history row is only
    // written when the value actually changes. Data-modifying CTEs aren't
    // visible to the outer SELECT, which therefore reads the pre-update
    // row — `tracking_mode` is patched to the new value below.
    const result = await this.pool.query<DeviceRow>(
      `WITH current AS (
         SELECT id, tracking_mode FROM devices WHERE id = $1 FOR UPDATE
       ), changed AS (
         UPDATE devices d SET tracking_mode = $2
         FROM current
         WHERE d.id = current.id AND current.tracking_mode <> $2
         RETURNING d.id
       ), history AS (
         INSERT INTO device_tracking_mode_history (device_id, tracking_mode, effective_from)
         SELECT id, $2, $3 FROM changed
       )
       SELECT d.* FROM devices d JOIN current ON current.id = d.id`,
      [id, mode, new Date(atMs)],
    );
    return result.rows[0] ? { ...toDevice(result.rows[0]), trackingMode: mode } : null;
  }

  async getCurrentTrackingModeChange(id: string): Promise<TrackingModeChange | null> {
    const result = await this.pool.query<{ effective_from: Date; tracking_mode: TrackingMode }>(
      `SELECT effective_from, tracking_mode FROM device_tracking_mode_history
       WHERE device_id = $1
       ORDER BY effective_from DESC, id DESC
       LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    return row ? { effectiveFrom: row.effective_from.getTime(), mode: row.tracking_mode } : null;
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
        `INSERT INTO activity_events (device_id, timestamp_utc) VALUES ${values.join(", ")}
         ON CONFLICT (device_id, timestamp_utc) DO NOTHING`,
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
