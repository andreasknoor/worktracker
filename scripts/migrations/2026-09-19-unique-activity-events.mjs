// One-off migration for an already-provisioned database: removes duplicate
// (device_id, timestamp_utc) rows left by tracker retries, then adds the
// unique index that schema.sql now includes for fresh installs, so event
// ingestion (INSERT ... ON CONFLICT DO NOTHING) is idempotent. Safe to re-run.
// Usage: DATABASE_URL=... node scripts/migrations/2026-09-19-unique-activity-events.mjs
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const deleted = await pool.query(`
    DELETE FROM activity_events a
    USING activity_events b
    WHERE a.device_id = b.device_id
      AND a.timestamp_utc = b.timestamp_utc
      AND a.id > b.id
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS activity_events_device_timestamp_uniq
      ON activity_events (device_id, timestamp_utc)
  `);
  console.log(`Migration applied: unique index on activity_events (removed ${deleted.rowCount ?? 0} duplicates)`);
} finally {
  await pool.end();
}
