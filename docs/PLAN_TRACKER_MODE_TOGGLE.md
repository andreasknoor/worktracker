# Implementation Plan: Per-Device Work/Leisure Mode, Switchable From the Tracker

Status: Phase 0 implemented in v1.22, Phase 1 in v1.23, Phase 2 in v1.24
(see `docs/IMPLEMENTATION_NOTES.md`); production rollout pending. Written 2026-10-01 against v1.21
(`bbeaaf5`). Builds on and supersedes the sequencing of
`docs/PLAN_TIMESTAMPED_WORK_LEISURE.md`: that plan's design decisions
(history table, immutability, server-time `effective_from`, grandfathering)
are adopted unchanged. This document adds an effort and risk assessment
based on a full read of the current code, and a phased rollout that
minimizes those risks.

## Goal

From the tracker's own menu (Mac menu bar, Windows tray), switch *this
device* between `auto`, `alwaysWork` and `alwaysLeisure`, effective **from
that moment on**. Past time keeps the classification that was in effect
when it was tracked. Today a change of `devices.tracking_mode` reclassifies
the device's entire history, because `classifyDay()` is evaluated at query
time against the current value (`filterByWorkType` in
`src/server/services/sessionsService.ts`).

## Design decisions (adopted from the earlier plan)

1. **History table** `device_tracking_mode_history (device_id,
   tracking_mode, effective_from)`. `devices.tracking_mode` stays as the
   current value (device list, dashboard buttons, and the rollback path; see
   R9).
2. **`effective_from` is server time at request receipt**, never
   client-supplied. No backdating, so a classified slice never changes once
   written (immutability rule).
3. **No offline queue for mode changes.** If the server is unreachable, the
   toggle fails visibly and the menu keeps the previous checkmark. Event
   timestamps keep being queued as today; they are classified by *their
   own* timestamp, so flush latency doesn't matter.
4. **Existing history is grandfathered**: one seed row per device with its
   current mode, `effective_from = created_at`.
5. **Classification granularity: exact instant**, not whole days. A session
   is split at midnight (existing) *and* at mode-change instants (new).

Considered and rejected for now: auto-expiry of a manual switch at midnight,
a separate "override" layer on top of the baseline, and client-supplied
`effectiveAt` with an offline queue. All three add state and edge cases.
Expiry can be added later as a pure classification rule without a schema
change.

## Effort estimate

Rough hours for implementation plus tests, assuming the existing patterns
(in-memory repos, `app.request` route tests) are reused.

| Phase | Work | Estimate |
|---|---|---|
| 0 | Preparation: clock injection, golden-numbers snapshot script | 2-3 h |
| 1a | `packages/core`: split at instants, history-based classification, tests | 3-4 h |
| 1b | Schema, migration + seed, Postgres/InMemory repo methods (transactional) | 3-4 h |
| 1c | Service integration, `PATCH`/`POST /api/devices` write history | 3-4 h |
| 1d | Rewrite existing tracking-mode tests for time-based semantics, new route/service tests | 3-4 h |
| 1e | Docs (`SESSION_LOGIC_SPEC`, `DATA_MODEL`, `API_CONTRACT`, `IMPLEMENTATION_NOTES`, `CLAUDE.md`), version bump, migration + deploy + golden-numbers check | 2-3 h |
| **Phase 1 total** | **Server + dashboard, usable via the dashboard alone** | **~16-22 h** |
| 2a | Server: `/api/tracker/*` endpoints with device-key auth, mode in `/api/events` response, tests | 2-3 h |
| 2b | Mac: API client, menu submenu, state handling, tests | 4-6 h |
| 2c | Windows: `Core` client + state (tested), tray submenu in `App` | 4-6 h |
| 2d | Manual verification on a real Windows machine and the Mac `.app` bundle | 1-2 h |
| **Phase 2 total** | **Toggle from the trackers** | **~11-17 h** |
| **Overall** | | **~27-39 h** |

The largest uncertainty is the Windows `App` shell. It can be compiled on
macOS but only verified on the Windows machine.

## Risk assessment

Likelihood/impact: L = low, M = medium, H = high.

| # | Risk | Where in the code | Prob. | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | **Tracker endpoint blocked by dashboard auth.** The earlier plan's `PATCH /api/devices/me/tracking-mode` falls under `app.use("/api/devices/*", requireDashboardSession)`, so a tracker would always get `401`. (`"me"` would also fail `isUuid()` on the `:id` routes.) | `src/server/app.ts` (auth wiring) | H if unchanged | M | Use a separate prefix `/api/tracker/*`, outside every dashboard gate, with its own device-key middleware registered on both the exact path and the `/*` form. Tests: no key → 401, revoked key → 401, a dashboard cookie alone → 401, a valid key → only its own device changes. |
| R2 | **Existing tests break by design.** `devices.test.ts` ("Work/leisure classification") PATCHes `trackingMode` at real `Date.now()` and then inserts events in March 2026. Under time-based semantics those events predate the change and are classified as `auto`, so the assertions fail. | `test/routes/devices.test.ts` | H | L | Add an injectable clock (`now: () => number` in `AppDependencies`, default `Date.now`) and rewrite these tests to switch the mode *before* the event times. Keep the old scenarios as explicit grandfathering tests (seed row at `created_at`). |
| R3 | **Silent change of real historical totals** if the seed is wrong or the new classification differs from the old one for unchanged devices. | migration, `filterByWorkType` | M | H | Run a golden-numbers check: before the migration, save `GET /api/stats/weeks?count=52&workType=work` and `…workType=leisure` (plus `/api/stats/month` for the last 12 months). After the deploy, both must match exactly. Add a core property test: a history with a single row gives exactly `classifyDay()`'s result. |
| R4 | **History and `devices.tracking_mode` drift apart.** Possible causes: no transaction, a PATCH through the old server between migration and deploy, or a device created by old code with no seed row. | repos, rollout window | M | M | (a) Update `devices` and insert the history row **atomically** and only if the value actually changed. As implemented: one statement with data-modifying CTEs and `SELECT … FOR UPDATE`, which is as atomic as `BEGIN … COMMIT` and costs one round trip instead of four. (b) Make the migration re-runnable and reconciling: it inserts a row for every device whose latest history row differs from `devices.tracking_mode`. Run it again after the deploy. (c) Fallback in the classifier: a device without history rows uses `devices.tracking_mode`. Before the first row, use the first row's mode. |
| R5 | **More DB load against the Neon free tier.** Every classified stats request now needs history rows. The dashboard always classifies at least two requests per render: the balance card (`fetchWeeksForBalance`, hard-wired to `workType=work`) and the daily-rhythm chart (default `work`). So a naive per-device query would run on nearly every refresh. | `getPerDeviceSessions` | M | M | **Zero extra round trips**: fetch history in the *same* query as the device list that `getPerDeviceSessions` already runs, and only when a `workType` filter is active. Never on the tracker hot path. See "Neon load budget" below. |
| R6 | **Wrong history window.** If the query covers only `[start, end)`, the mode governing the start of the range is missing. `getPerDeviceSessions` already reads events from `bufferedRangeStart(startMs, idleThreshold)`, and stats ranges are aligned to UTC midnight (`Date.parse(start + "T00:00:00Z")`), not to `APP_TIME_ZONE`. | `sessionsService.ts`, stats routes | M | M | The repo contract is "latest row with `effective_from <= bufferedStart`, plus every row in `(bufferedStart, end)`". Tests at range start, at range end, at local midnight versus UTC midnight, and on a DST day. |
| R7 | **Tracker shows a stale mode** after the dashboard changed it, or after a restart. | trackers | M | L | The tracker reads the mode on startup (`GET /api/tracker/mode`). After that it reads it from the **existing `POST /api/events` response**: today that response is an empty 201, and the handler already has the device row loaded, so returning `{ "trackingMode": … }` costs no extra query. Old trackers ignore the body. No periodic polling. |
| R8 | **Tracker UI regressions in untested shells.** CI covers only Mac `swift test` and Windows `Core`, not `StatusBarController.swift` or `TrayIconController.cs`. The Windows `App` can only be verified on Windows. | trackers | M | M | Keep the shells thin: put request/response handling and the mode state in testable types (Mac: a new `TrackingModeClient`/state type covered by `swift test`; Windows: `Core`). Error display reuses the existing non-modal status line pattern, with no dialogs. Do a manual test on both real machines before rollout. |
| R9 | **Rollback.** A rollback must not leave classification broken. | deploy | L | M | Keeping `devices.tracking_mode` as the current value means the v1.21 code still works on a migrated database: it ignores the new table and falls back to live classification. The migration only adds things, with no column drop and no type change. New trackers against an old server get `404` on `/api/tracker/*` and show "mode switch unavailable" while tracking continues. |
| R10 | **Mac build toolchain.** A CommandLineTools build broke the Settings fields (memory note, 2026-10-01); the `build-app.sh` fix is still open (v1.22 todo). | `mac-tracker/build-app.sh` | M | M | Land the pending `build-app.sh` fix (build with the full Xcode toolchain) **before** Phase 2, as its own version. |
| R11 | **Race between dashboard and tracker**, or rapid toggling. | server | L | L | Last write wins. History is ordered by `(effective_from, id)` (`bigserial` id as the tie-breaker). Rows that don't change the value are skipped (R4a). |
| R12 | **Abuse of the device key**: a stolen tracker key can now change classification too. | `/api/tracker/*` | L | L | The endpoint accepts only `trackingMode` for the key's own device. There is no device id parameter at all, so it can't reach other devices or settings. Revoked keys are rejected, as on `/api/events`. |
| R13 | **Hard delete / orphaned events.** | `DELETE ?permanent=true` | L | L | `ON DELETE CASCADE` on the history table, and the InMemory repo deletes rows explicitly. Orphaned events keep the flat `auto` fallback (`ORPHANED_TRACKING_MODE`), as today. |
| R14 | **Clock skew** between tracker and server at the moment of switching. | classification | L | L | Accepted. Events carry tracker time, while `effective_from` carries server time. A skew of a few seconds misclassifies at most those seconds. |

## Implementation plan

### Phase 0: Preparation (no behavior change)

1. Add `now: () => number` to `AppDependencies` (default `Date.now`) and
   use it in place of the direct `Date.now()` calls in `src/server/app.ts`
   (live view, revoke, touchLastSeen, and later the history writes).
2. Add `scripts/golden-numbers.mjs`, the acceptance check for R3. It runs
   **offline**, not against the production API: it reads `devices`,
   `activity_events` and (after the migration) `device_tracking_mode_history`
   from a single local export, loads them into the InMemory repositories,
   and computes the per-day `work`/`leisure`/`all` hours for the full
   history with both the old (`classifyDay` on the current mode) and the new
   (history-based) classification. They must be identical. See "Neon load
   budget" for why it isn't done via the HTTP API.
3. Prerequisite for Phase 2 only: land the pending Mac `build-app.sh` fix
   (R10).

### Phase 1: Time-based classification (server + dashboard)

**Core (`packages/core`)**
- `types.ts`: `TrackingModeChange { effectiveFrom: Timestamp; mode: TrackingMode }`.
- `statistics.ts`: `splitAtInstants(slices, instants)` splits day slices at
  the given instants. It is pure and keeps `date`.
- `time.ts` (or a new `classification.ts`): `modeAt(history, t, fallback)`
  and `classifySlices(slices, history, fallback)`. `classifyDay()` stays
  unchanged and is reused per slice.
- Tests: no history (fallback); a single row equals today's behavior; a
  switch mid-session; a switch exactly at midnight; several switches per
  day; a slice before the first row; a DST day in `Europe/Berlin`.

**Database**
- `schema.sql`: add `device_tracking_mode_history` as specified in the
  earlier plan (`bigserial id`, FK `ON DELETE CASCADE`, index on
  `(device_id, effective_from)`).
- `scripts/migrations/YYYY-MM-DD-tracking-mode-history.mjs`:
  `CREATE TABLE IF NOT EXISTS …` plus a reconciling seed: insert
  `(id, tracking_mode, created_at)` for every device without rows, and
  `(id, tracking_mode, now())` for every device whose latest row differs.
  It is re-runnable (R4b).

**Repositories**
- `DevicesRepository`:
  - `setTrackingMode(id, mode, atMs): Promise<Device | null>` updates the
    column and inserts the history row in one transaction, only if the value
    changed.
  - `listWithTrackingModeHistory(fromMs, toMs): Promise<Array<Device & { modeHistory: TrackingModeChange[] }>>`
    replaces the `list()` call in `getPerDeviceSessions` when a `workType`
    filter is active. It is **one** SQL statement: the device list plus a
    correlated `json_agg` subquery per device, returning only the history
    rows in `(fromMs, toMs)` plus the single governing row at or before
    `fromMs` (R5, R6). It selects only `effective_from` and `tracking_mode`
    from the history.
  - `create()` also writes the initial `auto` row (same transaction).
- `updateSettings()` no longer touches `tracking_mode`. `PATCH` routes
  `trackingMode` to `setTrackingMode`.
- InMemory equivalents, including history cleanup in `delete()`.

**Service and routes**
- `getPerDeviceSessions` loads history only when a `workType` filter is
  active. `filterByWorkType` uses `classifySlices` with the
  `devices.tracking_mode` fallback (R4c).
- `/api/stats/live` and `/first-activity` are unchanged (no `workType`).
- `GET`/`PATCH /api/devices` response shapes are unchanged.

**Dashboard (`public/js/app.js`)**
- Change only the wording. The tracking-mode buttons' toast and hint text
  should say the change applies **from now on**, not retroactively. No new
  UI is required.

**Tests**
- Rewrite the "Work/leisure classification" and "Device tracking mode"
  blocks in `test/routes/devices.test.ts` using the injected clock (R2).
- New: one device contributes work and leisure on the same day; history is
  written only on actual change; transaction semantics (InMemory mirrors
  them); `?deviceId=` plus `workType`; orphaned events stay `auto`.

**Rollout Phase 1**
1. Run the migration on Neon.
2. Merge to `main` (Vercel auto-deploys). Check `/api/version`.
3. Run the migration again (reconcile window, R4b).
4. Export the three tables once (one `COPY … TO STDOUT` per table) and run
   `golden-numbers.mjs` locally against the export. Numbers must be
   identical; if not, roll back the deploy (R9).
5. Docs plus the minor version bump in all three version constants.

### Phase 2: Toggle from the tracker

Start only after Phase 1 has run in production for a few days.

**Server**
- `requireDeviceKey` middleware, extracted from `POST /api/events`
  (Bearer lookup plus revoked check). Set the device on the context and
  reuse it in `/api/events`.
- `GET /api/tracker/mode` returns `{ trackingMode, effectiveFrom }`.
- `PUT /api/tracker/mode` with body `{ trackingMode }` calls
  `setTrackingMode(device.id, mode, now())` and returns the new state. It
  is idempotent (same value → no new row).
- `POST /api/events`: respond `201` with `{ trackingMode }` instead of an
  empty body (R7).
- Register both paths: `app.use("/api/tracker", requireDeviceKey)` and
  `app.use("/api/tracker/*", requireDeviceKey)`. Auth tests as listed in R1.

**Mac tracker**
- `APIClient.swift`: `getTrackingMode`, `setTrackingMode`. Decode the
  `trackingMode` from the events response (today discarded via
  `let (_, response)`).
- A small state holder (current mode plus last error), unit-tested with a
  fake client.
- `StatusBarController.swift`: a "Tracking mode ▸" submenu with Auto /
  Always work / Always leisure, a checkmark via `NSMenuItem.state`, and
  failure shown inline in the status lines.
- `AppDelegate.swift`: initial `GET` after `applyConfig`, and update the
  state after each successful flush.

**Windows tracker**
- `Core`: extend `EventsApiClient.cs` (`GetTrackingModeAsync`,
  `SetTrackingModeAsync`, and parse the events response). Add a mode state
  class with xUnit tests.
- `App/TrayIconController.cs`: a `ToolStripMenuItem "Tracking mode"` with
  three `Checked` children between `_errorItem` and Settings.
  `TrackerTrayApplicationContext.cs` does the wiring.
- `AppVersion.cs` bump.

**Rollout Phase 2**
1. Deploy the server part first. It is backward compatible, because old
   trackers ignore the response body.
2. Mac: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./build-app.sh`,
   install into `/Applications`, and test switching manually: check the
   dashboard, then `?workType=` on the same day.
3. Windows: on the Windows machine, `dotnet publish … -c Release` (this also
   covers the still-pending Windows rebuild) and run the same manual test.

## Neon load budget

Goal: the feature adds **no new periodic database traffic** and no
measurable network transfer. Neon's free tier limits both network transfer
(the 2026-09 overage) and compute hours.

### Current baseline (unchanged by this feature)

- **Tracker ingestion** (`POST /api/events`, every 15-30 s per active
  device): 3 queries per flush (`getByApiKeyHash`, insert,
  `touchLastSeen`). This keeps the Neon compute awake all day while anyone
  is tracking, so compute hours are already determined by tracking time.
- **Dashboard**: ~10 stats requests per render (on load, on tab return,
  and every 5 min while visible), plus `/api/stats/live` every 30 s. Each
  stats request runs `devices.list()` plus one raw-event range scan per
  device. **Those raw-event scans dominate transfer**, at about one row per
  poll interval per active device (~1,000 rows per device per tracked day).

### What the feature adds, and how each item is kept at zero

| Source | Naive version | Planned version | Extra queries | Extra transfer |
|---|---|---|---|---|
| Classified stats requests (≥ 2 per render: balance, rhythm) | +1 history query per device per request | History in the same statement as the device list (`listWithTrackingModeHistory`), only for `workType ≠ all` | **0** round trips | A few rows (only switches inside the range + 1 per device), ~50 bytes each |
| Unfiltered stats, `/api/stats/live`, `/first-activity` | – | Untouched; `list()` stays as is | 0 | 0 |
| `POST /api/events` (hot path) | Mode in a `devices` jsonb column would be read by `SELECT *` on every flush | History stays in its own table and is never read here. The mode returned to the tracker (R7) comes from the already-loaded `devices.tracking_mode` | **0** | ~25 bytes in the response (Vercel, not Neon) |
| Tracker learning the current mode | Polling `GET /api/tracker/mode` | One `GET` at tracker startup; afterwards via the events response | 1 per tracker start | negligible |
| Switching the mode | – | 1 short transaction, only on actual change | 1 per manual switch | negligible |
| Compute hours | – | No new periodic requests, so no extra wake-ups | – | – |
| Migration | – | One-off `CREATE TABLE` plus seed (one row per device) | one-off | negligible |
| Golden-numbers check | 52-week and 12-month stats via the API for 3 `workType`s, before **and** after the deploy: ~12 full-year raw-event scans per device | One-off `COPY` export of the tables, comparison computed locally | one-off | **One** full-history read instead of ~12 |

### Rules for the implementation

- History is read only in `getPerDeviceSessions` and only when a
  `workType` filter is active. Never in `getByApiKeyHash`, `getById` or
  `list()`.
- No `SELECT *` on the history table. Select only `effective_from` and
  `tracking_mode`.
- No new timers or polling, not in the dashboard and not in the trackers.
  Opening a tracker menu must not trigger a request.
- No in-process cache for the history. With more than one warm instance,
  a switch written by one instance would be invisible to another, giving
  wrong classification. The saving would be zero round trips anyway, since
  the history already shares a statement with the device list.
- Write only on an actual value change (R4a, R11).

### Possible follow-ups beyond this feature (not in scope)

This feature changes the total load by well under 1 %. Bigger savings are
in the existing raw-event scans: sharing one per-device event load across
the ~10 stats requests of a render (extending the `/api/stats/weeks`
pattern), or caching completed past weeks. Caching only becomes reasonably
safe once classification is immutable (this plan). Late-arriving offline
events and idle-threshold changes can still alter past days, so any cache
needs an invalidation rule for those.

## Out of scope

- Retroactively re-tagging past time (rejected by the immutability rule).
- Auto-expiry of a manual switch (can be added later as a classification
  rule).
- Holidays or time-of-day rules for `auto`.
- History for orphaned events of permanently deleted devices.
