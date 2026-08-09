// One-off migration for an already-provisioned database: makes
// activity_events.device_id nullable and changes its FK to ON DELETE SET
// NULL, so permanently deleting a device (as opposed to soft-revoking it)
// can null out its events' device_id instead of being blocked by (or
// cascading through) the foreign key. Safe to re-run.
// Usage: DATABASE_URL=... node scripts/migrations/2026-08-08-nullable-device-id.mjs
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`
    ALTER TABLE activity_events ALTER COLUMN device_id DROP NOT NULL;
    ALTER TABLE activity_events DROP CONSTRAINT IF EXISTS activity_events_device_id_fkey;
    ALTER TABLE activity_events
      ADD CONSTRAINT activity_events_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL;
  `);
  console.log("Migration applied: activity_events.device_id is now nullable (ON DELETE SET NULL)");
} finally {
  await pool.end();
}
