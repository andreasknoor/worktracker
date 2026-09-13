# Plan: Timestamped Work/Leisure Classification

Status: proposed, not implemented. Written 2026-09-11, updated 2026-09-13.

## Background

Today, work/leisure classification (`classifyDay()` in
`packages/core/src/time.ts`) is computed **live** at query time, per device
per calendar day, from the device's *current* `trackingMode` value
(`auto` | `alwaysWork` | `alwaysLeisure`). This means changing a device's
`trackingMode` retroactively reclassifies its entire history — there is no
concept of "what was this device's mode at the time the activity happened."

Goal: let a single physical device be used for both work and leisure over
time (e.g. switched between modes during the day) by "burning in" the
classification that was in effect at tracking time, instead of recomputing
it live from whatever the device's setting happens to be *now*.

Two design decisions were made up front (see rationale below):

1. **Granularity: per session/instant, not per day.** A device must be able
   to contribute both work and leisure time within the *same calendar day*
   if its mode was switched mid-day. Day-level burn-in alone would not
   satisfy the stated need (one device, both purposes, potentially same day).
2. **Historical data: frozen at the current value.** Pre-migration activity
   has no recorded "mode at the time" — the old system never persisted
   intent, only a mutable current setting. The only reconstructable option
   is to grandfather all existing history under each device's mode *as of
   the migration*, treated as if it had always been that value. Any earlier
   toggling that happened before this feature existed is unrecoverable and
   is intentionally not reconstructed.

## Immutability

Once a time slice has been classified and written to
`device_tracking_mode_history`, that classification is permanent. There is
no feature, planned or future, to manually re-tag a past session or day as
work/leisure after the fact — this was considered explicitly and rejected,
not merely deferred as out of scope. The server is the sole authority for
classification, and a classified slice never changes once written.

The only way to affect classification going forward is to change the
device's mode *now*, which writes a new history row effective from that
moment and governs everything from then on — it never touches slices that
were already classified under an earlier row.

## Known limitation, accepted up front

Burning in the mode at "tracking time" still requires the user to flip the
device's mode at the right real-world moment (e.g. before switching from
work to leisure use). This plan makes that switch *persist correctly*; it
does not remove the need to remember to make it. See "Phase 2 (optional):
client-side toggle" below for a UX mitigation that was considered — but,
per the immutability rule above, there is deliberately no retroactive-edit
mitigation.

## 1. Data model

New table, alongside the existing `devices.tracking_mode` column:

```sql
CREATE TABLE device_tracking_mode_history (
  id             bigserial PRIMARY KEY,
  device_id      uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  tracking_mode  text NOT NULL CHECK (tracking_mode IN ('auto', 'alwaysWork', 'alwaysLeisure')),
  effective_from timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_tracking_mode_history_device_idx
  ON device_tracking_mode_history (device_id, effective_from);
```

- `devices.tracking_mode` stays as-is: the **current** value, used for the
  device list/settings UI without a join.
- Every `PATCH /api/devices/:id` that changes `trackingMode` writes a new
  history row with `effective_from = now()` (server time at request receipt,
  not client-supplied) — only when the value actually changes, to avoid
  history noise from idempotent PATCHes.
- New devices get one initial row: `tracking_mode = 'auto'`,
  `effective_from = created_at`.

**Migration for existing devices** (a one-off script under
`scripts/migrations/`, following the existing convention): insert exactly
one history row per existing device, `tracking_mode` = that device's
current `devices.tracking_mode`, `effective_from = devices.created_at`.
This covers its entire existing history under the grandfathered value, per
the decision above.

## 2. `packages/core` — classification logic

- `classifyDay(dateKey, trackingMode)` is kept for callers that already
  have a single, known-fixed mode (still delegates to `isWeekend`).
- New: a function that splits a session list at *both* midnight boundaries
  (existing behavior, see `splitByDay`/`dailySegments` in
  `packages/core/src/statistics.ts`) *and* at tracking-mode change
  instants, given a sorted `{ effectiveFrom, mode }[]` history for that
  device. Each resulting slice is then classified via
  `classifyDay(dateOfSlice, modeDuringSlice)`.
- The slice shape stays compatible with the existing `WorkSession`/day-slice
  types so `mergeSessions()` / `mergeSessionsWithDeviceIds()` keep working
  unchanged on the finer-grained output.

## 3. Server layer

- `DevicesRepository` (`src/server/repositories/types.ts` +
  Postgres/InMemory implementations): new method, e.g.
  `getTrackingModeHistory(deviceId, rangeStartMs, rangeEndMs)`. Must include
  the last row effective at-or-before `rangeStartMs` (it governs from the
  start of the range up to the first in-range change) plus every change
  inside the range. Needs to cover the existing `bufferedRangeStart`
  lookback window used for idle-gap detection, not just the exact query
  range.
- `PATCH /api/devices/:id` (`src/server/app.ts`): when `trackingMode`
  changes, write the history row atomically with the `devices` update.
- `src/server/services/sessionsService.ts`: `getPerDeviceSessions`,
  `filterByWorkType`, `getAttributedSessionsInRange` move from "one
  `trackingMode` value per device" to "history per device."
- **Orphaned events** (`ORPHANED_TRACKING_MODE = "auto"`, for permanently
  deleted devices): explicitly out of scope. A deleted device's history
  rows cascade-delete with it (`ON DELETE CASCADE`); orphaned events keep
  the existing flat `auto` fallback. This is an accepted pre-existing
  limitation, not a regression introduced by this change.

## 4. What does NOT change

- The `GET`/`PATCH /api/devices` response shape stays the same — a single
  current `trackingMode` field. The history is an internal implementation
  detail for the stats endpoints, not a new dashboard-facing concept.
  (Possible future addition, not part of this plan: surfacing "in effect
  since ..." in the settings UI.)

## 5. Docs & versioning

- Update `docs/SESSION_LOGIC_SPEC.md`, `docs/DATA_MODEL.md`,
  `docs/API_CONTRACT.md` to describe history-based classification instead
  of a live snapshot.
- Update the "Two independent filter/coloring dimensions..." note in
  `CLAUDE.md` to reflect the new timestamped logic.
- Bump the minor app version (`1.x` → `1.x+1`) per the standing versioning
  instruction in `CLAUDE.md`.

## 6. Tests

- `packages/core`: unit tests for slice-splitting at mode-change instants,
  including combination with existing day-boundary splitting and DST edges
  (mirroring existing `splitByDay` test coverage).
- `src/server`: route test asserting `PATCH /api/devices/:id` writes a
  history row on change; service test showing a single device can
  contribute both work and leisure time within the same calendar day when
  its mode was switched mid-day.
- Update existing `classifyDay`/`filterByWorkType` tests for the new
  signature.

## Phase 2 (optional): client-side toggle

This section describes a possible follow-up UX convenience, evaluated and
scoped here for reference. **It is entirely optional and not a prerequisite
for anything in sections 1-6** — the core plan is fully self-contained and
usable via the dashboard alone. Nothing above depends on this being built.

Idea: let the tray apps trigger a mode change directly, instead of
requiring the user to open the dashboard.

**What this is not**: the client does not decide, store, or tag anything
itself. It is purely an alternative *trigger* for the exact same
server-side write described in section 1 (a new
`device_tracking_mode_history` row, `effective_from` = server receive
time). No client-local state, no per-event tagging, no offline queue for
this action.

**Why this needs a new endpoint, not just reusing the existing PATCH**: the
trackers authenticate only with their own per-device API key (`Authorization:
Bearer <api-key>`, used today solely for `POST /api/events`). `PATCH
/api/devices/:id` is gated by `requireDashboardSession` (password-cookie
auth) — a tracker holds no dashboard credential and cannot call it. A
narrow new endpoint would be needed, e.g. `PATCH
/api/devices/me/tracking-mode`, authenticated by the device's own API key
(same lookup as the events route) and excluded from
`requireDashboardSession` the way `/api/events` already is — scoped to
*only* let a device change its own `trackingMode`, nothing else.

**UI sketch**:
- Mac (`StatusBarController.swift`): a "Mode ▸" submenu between the
  existing status lines and "Settings…", with three items ("Auto", "Always
  Work", "Always Leisure"), checkmark (`NSMenuItem.state`) on the active
  one. Selecting an item fires the new endpoint; on failure, leave the
  checkmark unchanged and show a brief inline status instead of a blocking
  alert (per the existing no-dialogs style of this UI).
- Windows (`TrayIconController.cs`): analogous `ToolStripMenuItem "Mode"`
  with three checked child items, inserted between `_pendingItem` and the
  `settingsItem`.

**Scope/risk notes**:
- Touches the least test-covered code in the repo (macOS `AppKit` shell,
  Windows tray `App` shell — neither is exercised by `mac-tracker.yml`
  /`windows-tracker.yml`, which test `Core` only).
- No queue/batching semantics needed (unlike event sync) since the action
  is immediate, not buffered — keeping this simple is precisely why it's
  worth keeping optional/separate from the core plan rather than bundling
  it in.
- Should be built, if at all, as a strictly later, separate change once
  sections 1-6 are implemented and working via the dashboard.

## Open risks (accepted, not blockers)

- Manual timing remains error-prone (see "Known limitation" above).
- History grows unbounded with frequent toggling — irrelevant at
  single-user scale; no cleanup/compaction planned.
- Mode changes that happened before this feature existed are permanently
  unrecoverable, by design (see grandfathering decision above).
