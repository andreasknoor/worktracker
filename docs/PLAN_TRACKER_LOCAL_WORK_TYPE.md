# Plan: Choosing the Work Type in the Tracker

Status: implemented in v1.30 (see `docs/IMPLEMENTATION_NOTES.md`). Written
2026-10-02 against v1.29. Builds on `docs/PLAN_TRACKER_MODE_TOGGLE.md`
(v1.22-v1.24): the device's server-side tracking mode and its history are
kept unchanged, this plan adds a second, tracker-side source for the
classification.

## Functional view

Each tracker decides how the time it is currently capturing counts. The
tracker is an equal place for this decision, next to the dashboard. This is
a normal setting, not a special-case override.

The tracker menu offers three settings:

| Setting | How captured time counts |
|---|---|
| **Work** | as work, on any day |
| **Leisure** | as leisure, on any day |
| **As defined on server** | by the device's mode in the dashboard: *Auto* (weekdays work, weekends leisure), *Work* or *Leisure* |

Under the third option the menu shows what the dashboard currently says,
e.g. "As defined on server (currently: Auto)".

Behavior:

- **Applies from now on, never retroactively.** A switch only affects time
  captured afterwards.
- **Works offline.** The switch takes effect immediately without a server
  round trip. Time captured offline counts the way it was set at capture
  time. There are no "couldn't switch" errors any more.
- **Survives a restart.** The setting is stored with the tracker's config.
- **The dashboard governs only the third case.** The device mode set in the
  dashboard (Auto / Work / Leisure) applies only to time captured while the
  tracker is on "As defined on server". The tracker no longer changes the
  device mode on the server; that's done in the dashboard only.
- **Each device decides for itself.** Two devices active at the same time,
  one on Work and one on Leisure, show up as "mixed", as before.
- **The dashboard is unchanged.** It doesn't show where a classification
  came from.

Examples:

| Tracker | Device in dashboard | Time counts as |
|---|---|---|
| Work | Leisure | Work |
| Leisure | Auto, on a Tuesday | Leisure |
| As defined on server | Auto, on a Saturday | Leisure |
| As defined on server | Work | Work |

Transition and compatibility:

- Existing data keeps its classification: everything captured before the
  update counts as "captured under As defined on server".
- After the update every tracker starts on "As defined on server".
- Trackers that haven't been updated yet keep working and behave like "As
  defined on server" (they still show the old menu).
- Order: server first, then the Mac tracker, then the Windows tracker. A new
  tracker talking to an old server shows a hint that its choice isn't
  applied yet.

## Why the work type travels with each event

Events are captured, queued locally (possibly for days while offline) and
sent later. A switch that only reached the server when it was sent would
classify the wrong span of time. So the tracker stamps each queued event
with the setting in effect when it was captured, and the server stores it on
the event row. This is the same reason `PLAN_TRACKER_MODE_TOGGLE.md` refused
to queue server-side mode changes: a switch means something only at the
moment it happens.

## Technical design

### Data model

- `activity_events.work_type text NULL CHECK (work_type IN ('work',
  'leisure'))`. `NULL` means "as defined on server", which is what every
  existing row gets, so historic classification is unchanged.
- Migration `scripts/migrations/2026-10-02-event-work-type.mjs`
  (`ADD COLUMN IF NOT EXISTS`, safe to re-run, safe for the old server code,
  whose `INSERT` doesn't name the column). Must run before deploying the
  server.
- Orphaned events (device hard-deleted) keep their `work_type`.

### API

- `POST /api/events` accepts an optional batch-level `"workType": "work" |
  "leisure" | null`. Missing or `null` means "as defined on server", so old
  trackers are unaffected. Any other value is `400` (the tracker drops the
  chunk, as for any `400`).
- One work type per request: trackers split their chunks wherever the work
  type changes.
- The `201` response adds `"acceptsWorkType": true`. A tracker that sent a
  non-null work type and doesn't see this flag is talking to a pre-v1.30
  server that silently ignored it, and says so in its menu.
- Idempotency is unchanged (`ON CONFLICT DO NOTHING`). A queued entry's work
  type never changes, so a retried batch carries the same value.
- `GET`/`PUT /api/tracker/mode` stay for compatibility, but the trackers
  only use `GET` now.

### Classification (`packages/core`)

- `workTypeChangesFromEvents(events)` compresses a device's ordered events
  into change points `{ effectiveFrom, workType | null }`: one at the first
  event, then one at the first event of every run with a different value.
- `classifySlices(slices, history, fallback, workTypeChanges = [])` cuts
  slices at mode-history changes **and** at work-type change points. Each
  piece is classified as `workTypeAt(piece.start) ?? classifyDay(date,
  trackingModeAt(piece.start))`. Without change points the result is
  identical to v1.29.
- A piece between the last event of one run and the first event of the next
  counts as the earlier run, the same "value at piece start" rule as for
  mode history.
- An event dropped as noise by the resume-confirmation rule still sets a
  change point, but a change point outside every session cuts nothing.

### Server

- `ActivityEventsRepository.insertEvents(deviceId, timestamps, workType)`.
- `getEventsWithWorkTypesInRangeForDevice` / `…Orphaned…` return the
  timestamps and the compressed change points from **one** query. They're
  only used when classifying (`withModeHistory`), the plain variants stay for
  unfiltered views, so Neon load stays flat.
- `getPerDeviceSessions` passes the change points on to `classifySlices`.

### Trackers (Mac and Windows, kept in sync)

- New local setting `WorkTypeSetting`: `server` (default), `work`,
  `leisure`, stored as an optional field in `config.json`. Optional matters:
  both config loaders fall back to an empty config on a decode error, which
  would drop the API key.
- Queue entries become `(timestamp, workType?)`. The persisted format gains
  a parallel `workTypes` array; files without it load as all-`nil`, which is
  correct (those events were captured under the server mode).
- `flush()` sends the longest prefix of at most 1000 entries that share one
  work type.
- Menu: "Work", "Leisure", "As defined on server (currently: …)". Switching
  is local and instant. The server mode shown under the third entry still
  comes from `GET /api/tracker/mode` at startup and from every `POST
  /api/events` response.
- A warning line appears when a non-null work type was sent to a server
  without `acceptsWorkType`.

### Docs

`API_CONTRACT.md`, `DATA_MODEL.md`, `SESSION_LOGIC_SPEC.md`,
`IMPLEMENTATION_NOTES.md`, `CLAUDE.md`, both tracker READMEs.

## Rollout

1. Run the migration against Neon.
2. Deploy the server (v1.30); check `/api/version`.
3. Golden-numbers check: all rows are `NULL`, so the numbers must be
   identical to before.
4. Rebuild and install the Mac tracker; check the menu.
5. Rebuild the Windows tracker on Windows; check the menu.
