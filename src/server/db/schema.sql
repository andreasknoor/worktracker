-- WorkTracker schema (Postgres, via Vercel Marketplace / Neon).
--
-- Deviation from the original handoff package's DATA_MODEL.md: idleThreshold
-- and pollInterval moved from the global `settings` table to per-device
-- columns on `devices`, so each tracker installation can be tuned
-- independently. See docs/IMPLEMENTATION_NOTES.md.
--
-- This file is only applied in full to a fresh database (`npm run
-- db:apply-schema`, a plain `CREATE TABLE` with no `IF NOT EXISTS`). An
-- already-provisioned database needs the corresponding ALTER statement
-- instead — see `scripts/migrations/` for one-off scripts that were actually
-- run against the real (Neon) database, in the order they were added.

CREATE TABLE devices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  platform                text NOT NULL CHECK (platform IN ('windows', 'mac')),
  api_key_hash            text NOT NULL,
  idle_threshold_minutes  integer NOT NULL DEFAULT 30 CHECK (idle_threshold_minutes > 0),
  poll_interval_seconds   integer NOT NULL DEFAULT 30 CHECK (poll_interval_seconds > 0),
  -- Work/leisure classification override for this device's logged time.
  -- 'auto' derives it from the calendar (weekday = work, weekend = leisure);
  -- 'alwaysWork'/'alwaysLeisure' pin it regardless of day, e.g. a company PC
  -- that should count as work even on a weekend. See classifyDay() in
  -- packages/core/src/time.ts.
  tracking_mode           text NOT NULL DEFAULT 'auto' CHECK (tracking_mode IN ('auto', 'alwaysWork', 'alwaysLeisure')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz,
  revoked_at              timestamptz
);

CREATE UNIQUE INDEX devices_api_key_hash_idx ON devices (api_key_hash);

CREATE TABLE activity_events (
  id            bigserial PRIMARY KEY,
  -- Nullable: permanently deleting a device (as opposed to soft-revoking it)
  -- sets its events' device_id to NULL rather than deleting them, so
  -- historical activity survives the device row itself. These "orphaned"
  -- events still count toward the aggregated totals/timeline (see
  -- getOrphanedEventsInRange in sessionsService.ts), just without a device
  -- name/color to attribute them to.
  device_id     uuid REFERENCES devices (id) ON DELETE SET NULL,
  timestamp_utc timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_events_device_timestamp_idx ON activity_events (device_id, timestamp_utc);
CREATE INDEX activity_events_timestamp_idx ON activity_events (timestamp_utc);

-- Global settings: only dashboard-display preferences remain global.
-- idleThresholdMinutes / pollIntervalSeconds live on `devices` (see above).
-- startWithWindows was dropped entirely (ambiguous in a multi-device model;
-- autostart is now a purely local, per-OS tracker concern).
CREATE TABLE settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
