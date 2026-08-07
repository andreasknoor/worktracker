-- WorkTracker schema (Postgres, via Vercel Marketplace / Neon).
--
-- Deviation from the original handoff package's DATA_MODEL.md: idleThreshold
-- and pollInterval moved from the global `settings` table to per-device
-- columns on `devices`, so each tracker installation can be tuned
-- independently. See docs/IMPLEMENTATION_NOTES.md.

CREATE TABLE devices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  platform                text NOT NULL CHECK (platform IN ('windows', 'mac')),
  api_key_hash            text NOT NULL,
  idle_threshold_minutes  integer NOT NULL DEFAULT 30 CHECK (idle_threshold_minutes > 0),
  poll_interval_seconds   integer NOT NULL DEFAULT 30 CHECK (poll_interval_seconds > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz,
  revoked_at              timestamptz
);

CREATE UNIQUE INDEX devices_api_key_hash_idx ON devices (api_key_hash);

CREATE TABLE activity_events (
  id            bigserial PRIMARY KEY,
  device_id     uuid NOT NULL REFERENCES devices (id),
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
