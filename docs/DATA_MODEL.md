# Data Model

This is the target schema for the new Postgres database. It is a new design (informed by the old SQLite schema) — not a migration, since no historical data is being carried over.

## `devices`

One row per tracker installation (one Windows laptop, one Mac laptop, etc.).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid / serial PK | |
| `name` | text | user-chosen label, e.g. "Work Laptop (Windows)" |
| `platform` | text | `"windows"` \| `"mac"` — informational only |
| `api_key_hash` | text | hash of the device's API key (never store the raw key) |
| `idle_threshold_minutes` | integer | per-device, not global — see `IMPLEMENTATION_NOTES.md` |
| `poll_interval_seconds` | integer | per-device, not global — see `IMPLEMENTATION_NOTES.md` |
| `tracking_mode` | text | `"auto"` (default) \| `"alwaysWork"` \| `"alwaysLeisure"` — the device's **current** work/leisure mode (overrides the default weekday=work/weekend=leisure classification). Classification itself uses `device_tracking_mode_history` below, so changing this never reclassifies past time; see `API_CONTRACT.md`'s "Work/leisure filtering" |
| `created_at` | timestamptz | |
| `last_seen_at` | timestamptz, nullable | updated on each successful event ingest |
| `revoked_at` | timestamptz, nullable | soft-revoke (`DELETE /api/devices/{id}`) — key stops working, row and history stay intact. A device can additionally be hard-deleted (`?permanent=true`, only once already revoked) via `DevicesRepository.delete`; see `activity_events.device_id` below for what happens to its events. |

## `device_tracking_mode_history`

Every `tracking_mode` a device has had, and from when. Work/leisure
classification uses the mode **in effect when the activity happened**
(`classifySlices` in `packages/core/src/classification.ts`).

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | tie-breaker for two rows with the same `effective_from` (the later row wins) |
| `device_id` | uuid FK → `devices.id`, `ON DELETE CASCADE` | a permanently deleted device's history goes with it; its orphaned events fall back to `auto` |
| `tracking_mode` | text | same values as `devices.tracking_mode` |
| `effective_from` | timestamptz | server time when the change was received — never client-supplied and never in the past, so a classified time slice never changes afterwards |
| `created_at` | timestamptz | insert time (ops/debugging only) |

Index: `(device_id, effective_from)`. A device's first row is written with
the device itself (`auto`, effective from `created_at`); existing devices
were seeded with their mode at migration time, effective from `created_at`
(`scripts/migrations/2026-10-01-tracking-mode-history.mjs`). A new row is
only written when the mode actually changes, together with
`devices.tracking_mode` in one atomic statement. Activity before a device's
first row uses that first row's mode; a device without rows uses
`devices.tracking_mode`.

## `activity_events`

Raw activity timestamps only — never key content, window titles, or application names. This is the single source of truth; work sessions are always derived from this table, never persisted.

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `device_id` | uuid/int FK → `devices.id`, **nullable**, `ON DELETE SET NULL` | Null means the owning device was permanently deleted (see above) — the event row itself is never deleted, so historical hours keep counting, just without a device to attribute them to (`getOrphanedEventsInRange` in `sessionsService.ts`, folded into the aggregated view using default idle-threshold/poll-interval/`auto`-tracking-mode settings). |
| `timestamp_utc` | timestamptz | when the input event occurred (client-observed time, sent as UTC) |
| `work_type` | text, **nullable**, `'work'` / `'leisure'` | the work type chosen in the tracker's menu when the event was captured (v1.30); `NULL` = "as defined on the server", i.e. the device's tracking-mode history decides. Every event before v1.30 is `NULL`. Stamped per event because events can sit in a tracker's offline queue for days (`scripts/migrations/2026-10-02-event-work-type.mjs`). |
| `created_at` | timestamptz | server insert time (for debugging/ops, not used in calculations) |

Index: `(device_id, timestamp_utc)` and a plain index on `timestamp_utc` for cross-device range queries.

## `settings`

Global key/value store, same shape as the original SQLite `Settings` table — single source of truth for tracker + dashboard configuration. (If multi-user support is ever added later, this would need a `user_id` column; out of scope for v1, which is single-user/multi-device.)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `IdleThresholdMinutes` | number | `30` | gap size (minutes) that ends a session |
| `PollIntervalSeconds` | number | `30` | how often trackers poll for new input |
| `CoreHoursStart` | `"HH:mm"` string | `"09:00"` | highlighted band start in the timeline chart |
| `CoreHoursEnd` | `"HH:mm"` string | `"18:00"` | highlighted band end in the timeline chart |
| `DeviceStaleThresholdHours` | number | `24` | hours since a device's `lastSeenAt` before the dashboard's health banner warns about it |

Note: `StartWithWindows` and `TrackerExePath` from the original schema were tracker-local concerns (Windows registry autostart, tracked via the dashboard talking to the same local machine). In the client/server model, autostart is configured locally per tracker installation (each OS's own mechanism) and is no longer something the server needs to store or broker — the dashboard no longer has a way to reach into a specific device's OS to toggle it. If per-device autostart status still needs to be visible in the dashboard, model it as a per-device field (e.g. `devices.autostart_enabled`, reported by the tracker itself), not a global setting.

## Derived, never persisted

- **Work sessions** — computed from `activity_events` + `IdleThresholdMinutes` via the session-calculation logic (`SESSION_LOGIC_SPEC.md`). Recomputing from raw data means changing the idle threshold retroactively recalculates all history with no migration.
- **Daily/weekly/monthly aggregates, "live" today/current-session state** — all computed on read from sessions, exactly as in the original `StatisticsService`.
