// One-off migration for an already-provisioned database: adds the
// `device_tracking_mode_history` table that schema.sql now includes for
// fresh installs, and reconciles it with `devices.tracking_mode`:
//  - a device without any history row gets one with its current mode,
//    effective from its created_at (grandfathers its entire existing
//    history under the mode it has today — the pre-history classification);
//  - a device whose latest history row differs from its current mode (e.g.
//    changed through a not-yet-updated server between migrating and
//    deploying) gets a row with its current mode, effective now.
// Safe to re-run; run it once before and once after deploying.
// Usage: DATABASE_URL=... node scripts/migrations/2026-10-01-tracking-mode-history.mjs
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS device_tracking_mode_history (
      id             bigserial PRIMARY KEY,
      device_id      uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
      tracking_mode  text NOT NULL CHECK (tracking_mode IN ('auto', 'alwaysWork', 'alwaysLeisure')),
      effective_from timestamptz NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS device_tracking_mode_history_device_idx
      ON device_tracking_mode_history (device_id, effective_from);
  `);
  const seeded = await client.query(`
    INSERT INTO device_tracking_mode_history (device_id, tracking_mode, effective_from)
    SELECT d.id, d.tracking_mode, d.created_at FROM devices d
    WHERE NOT EXISTS (SELECT 1 FROM device_tracking_mode_history h WHERE h.device_id = d.id)
  `);
  const reconciled = await client.query(`
    INSERT INTO device_tracking_mode_history (device_id, tracking_mode, effective_from)
    SELECT d.id, d.tracking_mode, now() FROM devices d
    WHERE d.tracking_mode <> (
      SELECT h.tracking_mode FROM device_tracking_mode_history h
      WHERE h.device_id = d.id
      ORDER BY h.effective_from DESC, h.id DESC
      LIMIT 1
    )
  `);
  await client.query("COMMIT");
  console.log(
    `Migration applied: device_tracking_mode_history (seeded ${seeded.rowCount ?? 0} device(s), ` +
      `reconciled ${reconciled.rowCount ?? 0})`,
  );
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
  await pool.end();
}
