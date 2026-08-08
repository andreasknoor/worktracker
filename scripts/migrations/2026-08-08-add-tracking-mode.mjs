// One-off migration for an already-provisioned database: adds the
// `tracking_mode` column that schema.sql's `CREATE TABLE devices` now
// includes for fresh installs. Safe to re-run (IF NOT EXISTS).
// Usage: DATABASE_URL=... node scripts/migrations/2026-08-08-add-tracking-mode.mjs
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'auto';
    ALTER TABLE devices
      DROP CONSTRAINT IF EXISTS devices_tracking_mode_check;
    ALTER TABLE devices
      ADD CONSTRAINT devices_tracking_mode_check CHECK (tracking_mode IN ('auto', 'alwaysWork', 'alwaysLeisure'));
  `);
  console.log("Migration applied: devices.tracking_mode");
} finally {
  await pool.end();
}
