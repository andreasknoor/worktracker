// One-off migration for an already-provisioned database: adds the nullable
// `activity_events.work_type` column that schema.sql now includes for fresh
// installs. Existing rows stay NULL ("as defined on the server"), so their
// classification doesn't change. Adding a nullable column without a default
// is a metadata-only change in Postgres (no table rewrite), and the pre-v1.30
// server keeps working against it, since its INSERT doesn't name the column.
// Safe to re-run. Run it before deploying v1.30.
// Usage: DATABASE_URL=... node scripts/migrations/2026-10-02-event-work-type.mjs
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`
    ALTER TABLE activity_events
      ADD COLUMN IF NOT EXISTS work_type text CHECK (work_type IN ('work', 'leisure'))
  `);
  const counts = await pool.query(
    `SELECT count(*)::int AS total, count(work_type)::int AS stamped FROM activity_events`,
  );
  const { total, stamped } = counts.rows[0];
  console.log(`Migration applied: activity_events.work_type (${total} events, ${stamped} with a work type)`);
} finally {
  await pool.end();
}
