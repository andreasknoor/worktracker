# API Contract

The dashboard frontend in `dashboard-frontend/` is being kept close to unchanged from the original. It calls these exact endpoints, paths, query params, and JSON field names (all camelCase). **The new server must match this contract precisely** — if an endpoint shape needs to change, update the frontend's `js/app.js` deliberately, don't let the two drift apart silently.

All dates are `"yyyy-MM-dd"` strings; all times within a day are `"HH:mm"` 24h strings; all timestamps sent by trackers are ISO 8601 UTC.

## Stats endpoints (all `GET`, all read-only, all consumed by the dashboard)

### `GET /api/stats/week?start=yyyy-MM-dd`
`start` is expected to be a Monday (the frontend always passes one). Returns 7 days starting there.
```json
{
  "weekStart": "2026-03-09",
  "weekEndExclusive": "2026-03-16",
  "days": [{ "date": "2026-03-09", "hours": 7.5, "workHours": 6, "mixedHours": 0.5, "leisureHours": 1 }, ...]
}
```
`workHours` / `mixedHours` / `leisureHours` split `hours` by work type (see
"Work/leisure attribution" below). They're disjoint and add up to `hours`.
`mixedHours` is time when work and leisure overlapped on two devices. Under
`?workType=work|leisure` everything falls into that one type and the other two
are `0`. Days excluded by `?dayType=` are zeroed in all four fields. The same
fields appear in `/weeks` and `/month`. Servers before v1.26 sent only `hours`.

### `GET /api/stats/weeks?start=yyyy-MM-dd&count=n`
Batched form of `/api/stats/week`: returns `count` (1-52) consecutive weeks starting at `start` in one response, computing the combined range once server-side instead of once per week. Added for the dashboard's target-balance chart, which otherwise needed `balanceWindowWeeks + 1` separate `/api/stats/week` calls on every refresh — see `docs/IMPLEMENTATION_NOTES.md` ("Dashboard polling exceeded Neon's free-tier network transfer allowance"). `count` defaults to `1` if omitted.
```json
{
  "weeks": [
    { "weekStart": "2026-02-23", "weekEndExclusive": "2026-03-02", "days": [{ "date": "2026-02-23", "hours": 7.5, "workHours": 7.5, "mixedHours": 0, "leisureHours": 0 }, ...] },
    { "weekStart": "2026-03-02", "weekEndExclusive": "2026-03-09", "days": [...] },
    ...
  ]
}
```

### `GET /api/stats/week-timeline?start=yyyy-MM-dd`
Same week window, but per-day clock-time segments instead of totals (for the "Timeline" chart mode). Each segment carries `workType`: `"work"`, `"leisure"`, or `"mixed"` (work and leisure overlapping on two devices), which the Timeline chart is colored by. It also carries `deviceIds`: every device active somewhere within the segment, for tooltips only. Segments are cut only where the work type changes, not at device handovers. See "Work/leisure attribution" below.
```json
{
  "weekStart": "2026-03-09",
  "weekEndExclusive": "2026-03-16",
  "days": [
    {
      "date": "2026-03-09",
      "segments": [
        { "startMinutes": 540, "endMinutes": 690, "workType": "work", "deviceIds": ["a1b2..."] },
        { "startMinutes": 690, "endMinutes": 720, "workType": "mixed", "deviceIds": ["a1b2...", "c3d4..."] },
        { "startMinutes": 780, "endMinutes": 1020, "workType": "leisure", "deviceIds": ["c3d4..."] }
      ]
    },
    ...
  ]
}
```

### `GET /api/stats/month?month=yyyy-MM-dd`
Any date within the target month; only year/month are used. Returns all days of that calendar month.
```json
{
  "monthStart": "2026-02-01",
  "monthEndExclusive": "2026-03-01",
  "days": [{ "date": "2026-02-01", "hours": 0, "workHours": 0, "mixedHours": 0, "leisureHours": 0 }, ...]
}
```

### `GET /api/stats/summary?days={n}&end=yyyy-MM-dd` (both optional; default `days=7`, `end=`tomorrow)
Range is `[end - days, end)`. Used both for the current period and (called again with a shifted `end`) for "vs. prior period" deltas.
```json
{
  "totalHours": 32.5,
  "activeDayCount": 5,
  "rangeDayCount": 7,
  "averageHoursPerActiveDay": 6.5,
  "longestSessionMinutes": 245,
  "daily": [{ "date": "2026-03-09", "hours": 7.5 }, ...]
}
```

### `GET /api/stats/sessions?days={n}&end=yyyy-MM-dd` (both optional; default `days=7`, `end=`tomorrow)
Individual sessions in `[end - days, end)`, most recent first.
```json
[
  { "date": "2026-03-11", "start": "09:02", "end": "12:47", "durationMinutes": 225, "deviceIds": ["..."] },
  ...
]
```
`deviceIds` uses the same device-attribution mechanism as `week-timeline` (see
"Device attribution" below): the device(s) that contributed to that segment,
`[]` if none matched (shouldn't normally happen), 2+ entries when devices
overlapped in that interval. With `?deviceId=` set it's always `[deviceId]`
or `[]`.

### `GET /api/stats/live`
Polled every 15s by the dashboard for the live ring/timer.
```json
{ "isActive": true, "todaySeconds": 14520, "currentSessionSeconds": 1830, "activeDeviceIds": ["..."] }
```
`activeDeviceIds` lists the device(s) contributing to the still-running
session (empty when `isActive` is `false`), via the same device-attribution
mechanism as `week-timeline` (see "Device attribution" below) applied to the
live range instead of a historical one. With `?deviceId=` set it's just
`[deviceId]` or `[]`; the dashboard only shows it in the "all devices" view
since a single-device filter already implies the answer.

### `GET /api/stats/first-activity`
Anchors the "All time" range filter.
```json
{ "date": "2025-11-03" }   // or { "date": null } if nothing tracked yet
```

## Settings endpoints

**Deviation from the original design** (see `docs/IMPLEMENTATION_NOTES.md`):
`idleThresholdMinutes`/`pollIntervalSeconds` moved to per-device columns —
set them via `PATCH /api/devices/{id}` below, not here — and
`startWithWindows` was dropped entirely (its meaning was ambiguous once
multiple devices exist; autostart is now a purely local, per-OS tracker
concern with no server-side representation). Only dashboard-display
preferences remain global.

### `GET /api/settings`
```json
{
  "coreHoursStart": "09:00",
  "coreHoursEnd": "18:00",
  "deviceStaleThresholdHours": 24,
  "weeklyTargetHours": 40,
  "balanceWindowWeeks": 8
}
```
`weeklyTargetHours` and `balanceWindowWeeks` back the dashboard's weekly
target/balance card: `weeklyTargetHours` is the work-time target for a full
calendar week (spread evenly over Mon-Fri for the "target by now" figure);
`balanceWindowWeeks` is how many complete previous weeks the "carried
balance" tile sums over. Deliberately a rolling window rather than a stored
start date — see `docs/IMPLEMENTATION_NOTES.md`.

No trailing slash — the original `.NET` reference implementation's ASP.NET
Core convention was `/api/settings/`, but on Vercel a path with a trailing
slash doesn't match the `/api/:path*` rewrite's compiled regex (Vercel
requires each path segment to be non-empty), so it 404s before ever
reaching the app. See `docs/IMPLEMENTATION_NOTES.md`.

### `PUT /api/settings`
Request body same shape as the `GET` response. Validation:
- `coreHoursStart`/`coreHoursEnd` must parse as `HH:mm`, else `400`.
- `coreHoursEnd` must be strictly after `coreHoursStart`, else `400`.
- `deviceStaleThresholdHours` must be a positive number, else `400`.
- `weeklyTargetHours` must be a positive number of at most 168 (a full week), else `400`.
- `balanceWindowWeeks` must be a positive integer of at most 52, else `400`.
- A malformed JSON body returns `400` rather than a raw parse error.

Returns the saved settings (same shape as `GET`).

## Event ingestion (new — trackers, not the dashboard, call this)

### `POST /api/events`
Headers: `Authorization: Bearer <device-api-key>`, `Content-Type: application/json`.
```json
{ "timestamp": "2026-03-11T09:02:15.123Z" }
```
or a small batch (recommended, so a tracker can flush a short local queue after a network blip):
```json
{ "timestamps": ["2026-03-11T09:02:15.123Z", "2026-03-11T09:02:45.400Z"] }
```
Optionally with the work type all of these events were captured under (v1.30), as chosen in the tracker's menu:
```json
{ "timestamps": ["2026-03-11T09:02:15.123Z"], "workType": "leisure" }
```
- `workType`: `"work"`, `"leisure"`, or missing/`null` for "as defined on the server" (the device's tracking mode decides, see "Work/leisure filtering"). Anything else is `400`. Stored per event (`activity_events.work_type`), because a tracker may send events long after capturing them. One work type per request; trackers split their batches where it changes.
- `401` if the API key is missing/invalid/revoked.
- `400` if the batch exceeds 5000 timestamps in one request, or if none of the provided timestamps parse.
- Ingestion is idempotent: `activity_events` has a unique index on `(device_id, timestamp_utc)` and inserts use `ON CONFLICT DO NOTHING`, so a tracker re-sending a batch after a timeout or partial failure creates no duplicates (and the first stored `workType` stays). **The migration `scripts/migrations/2026-09-19-unique-activity-events.mjs` must be run before deploying code that relies on this**, otherwise `ON CONFLICT` fails with a 500.
- Trackers send at most 1000 timestamps per request (chunked), retry 5xx/network/401 with exponential backoff, and drop a chunk only on 400/413/422.
- Server resolves the key to a `device_id`, inserts one row per timestamp into `activity_events`, and updates that device's `last_seen_at`.
- `201` with `{ "trackingMode": "auto" | "alwaysWork" | "alwaysLeisure", "acceptsWorkType": true }`: the device's current tracking mode, so a tracker learns about a change made in the dashboard within one flush interval without polling (the device row is already loaded for authentication — no extra query). Servers before v1.24 answered with an empty body; trackers accept both. `acceptsWorkType` (v1.30) tells a tracker its `workType` was stored; a tracker that sent one and doesn't see the flag is talking to an older server that silently ignored it, and says so in its menu.

## Tracker self-service (device API key)

Trackers can read and switch their **own** tracking mode — nothing else, and
no other device (there's no device id in these routes). Since v1.30 the
trackers only read it (to show it under "As defined on server"); their own
choice of work type travels with the events instead (see `POST
/api/events`). `PUT` stays for compatibility. Authenticated like
`/api/events` (`Authorization: Bearer <device-api-key>`; `401` if missing,
invalid or revoked); a dashboard session cookie is **not** accepted. The
`/api/tracker` prefix deliberately lies outside every dashboard-gated prefix.

### `GET /api/tracker/mode`
```json
{ "trackingMode": "alwaysLeisure", "effectiveFrom": "2026-10-01T14:30:00.000Z" }
```
`effectiveFrom` is when the current mode took effect (null only for a device
with no history row).

### `PUT /api/tracker/mode`
Request: `{ "trackingMode": "auto" | "alwaysWork" | "alwaysLeisure" }`, else
`400`. Same effect as the dashboard's `PATCH /api/devices/{id}` with
`trackingMode`: the change takes effect from the time it's received, and
re-sending the current mode is a no-op that keeps the original
`effectiveFrom`. Returns the same shape as `GET`. Trackers don't queue
switches made while offline. They fail visibly instead, since a switch only
means something at the moment it happens.

## Device management (new — dashboard admin UI, not yet in the original prototype)

### `GET /api/devices`
```json
[
  {
    "id": "...",
    "name": "Work Laptop (Windows)",
    "platform": "windows",
    "idleThresholdMinutes": 30,
    "pollIntervalSeconds": 30,
    "trackingMode": "auto",
    "lastSeenAt": "2026-03-11T09:02:45Z",
    "revoked": false
  },
  ...
]
```
List order is creation order (`created_at ASC`) — used by the dashboard to assign each device a stable color slot for the Timeline chart, so a device's color doesn't reshuffle when another device is added or revoked.

### `POST /api/devices`
Request: `{ "name": "...", "platform": "windows" | "mac" }`. `name` is trimmed and must be 1-100 characters after trimming, else `400`. New devices always start with `trackingMode: "auto"` (change it afterwards via `PATCH`). Response includes the **raw** API key exactly once (never retrievable again, same convention as GitHub/Stripe-style tokens):
```json
{ "id": "...", "name": "...", "platform": "windows", "apiKey": "wtk_live_..." }
```

### `PATCH /api/devices/{id}`
Request: `{ "idleThresholdMinutes"?: number, "pollIntervalSeconds"?: number, "trackingMode"?: "auto" | "alwaysWork" | "alwaysLeisure" }` (any subset). `idleThresholdMinutes`/`pollIntervalSeconds`, if present, must be `> 0`; `trackingMode`, if present, must be one of the three listed values — else `400`. `404` if the id isn't a valid uuid or doesn't match a device. Returns the updated device (same shape as one `GET /api/devices` entry, minus `apiKey`). A `trackingMode` change takes effect **from the time the request is received** (it's appended to the device's tracking-mode history, see `DATA_MODEL.md`); time tracked before keeps its classification. Re-sending the current mode is a no-op.

### `DELETE /api/devices/{id}`
Revokes the device's key (soft-revoke — see `DATA_MODEL.md`). `204` on success, `404` if the id isn't a valid uuid or doesn't match a device.

### `DELETE /api/devices/{id}?permanent=true`
Hard-deletes the device row itself, rather than soft-revoking it. Requires the device to already be revoked (`400` otherwise: `"Device must be revoked before it can be permanently deleted"`) — revoke first, delete only once you're sure; this is irreversible. `204` on success, `404` if the id isn't a valid uuid or doesn't match a device.

The device's historical `activity_events` are **not** deleted — their `device_id` is set to `NULL` (`ON DELETE SET NULL`) instead, so past hours keep counting toward totals and the Timeline chart. These orphaned events show up with no device attribution (an empty/unmatched `deviceIds` entry in `week-timeline`, which the dashboard already renders as "Unknown device" in a neutral color — the same fallback path used for any unrecognized device id) and use default idle-threshold/poll-interval/`auto` tracking-mode settings for session calculation, since the original device's own tuning no longer exists anywhere. Once deleted, `?deviceId={id}` for that device returns `404` like any other unknown id.

## Per-device filtering

All `/api/stats/*` endpoints accept an optional `?deviceId=` query param,
scoping the result to a single device instead of the merged all-devices view.
An unknown or malformed id returns `404` rather than silently empty data. See
`docs/IMPLEMENTATION_NOTES.md`.

## Day-type filtering

`GET /api/stats/week`, `/weeks`, `/week-timeline`, `/month`, `/summary`, and
`/sessions` accept an optional `?dayType=all|weekday|weekend` query param
(default `all`). `weekday` scopes to Mon-Fri, `weekend` to Sat-Sun. An
unrecognized value returns `400`. Endpoints that return a fixed calendar
shape (`week`, `week-timeline`, `month`) keep every date in the response but
zero out non-matching days (`hours: 0` / `segments: []`) rather than
shrinking the array, so callers can keep rendering a full calendar grid.
`summary`'s `longestSessionMinutes` is scoped to sessions whose *start* falls
on a matching day. `live` and `first-activity` don't accept this param — a
"day type" filter doesn't apply to "right now" or to an anchor date.

## Work/leisure filtering

A second, independent filter dimension from day-type above: `GET
/api/stats/week`, `/weeks`, `/week-timeline`, `/month`, `/summary`, and `/sessions`
additionally accept `?workType=work|leisure|all` (default `all`; `400` on an
unrecognized value). `dayType` and `workType` can be combined — they're
applied independently, not as alternatives.

Classification is per device. Two sources decide, both by their value
**when the activity happened**:
1. the work type the tracker stamped on the events (`workType` in `POST
   /api/events`, chosen in the tracker's menu), if it isn't `null`;
2. otherwise the `trackingMode` the device had at that time (its
   tracking-mode history, see `DATA_MODEL.md`), per calendar day —
   *not* its current mode, and *not* a raw weekday/weekend check on the
   query range as a whole.

Neither source is a special case of the other: the tracker's "As defined on
server" setting simply hands the decision to the device's mode. A session is cut at every mode change,
so a device switched mid-day contributes both work and leisure time to that
day:
- `auto` (the default): weekday → work, weekend → leisure.
- `alwaysWork` / `alwaysLeisure`: pins that device's time regardless of day —
  e.g. a company PC whose weekend activity should still count as work.

A session is also cut wherever the stamped work type changes, so a tracker
switched mid-session contributes to both types.

Because classification is per device, a single calendar day can contain both
work and leisure time (one device pinned to always-work, another left on
auto, both active on the same Saturday). Sessions from two devices in the
*same* bucket are deduplicated via the normal cross-device overlap-merge;
overlapping time from a work-classified device and a leisure-classified
device is **not** merged with each other and counts in full toward both
totals — they're different categories, not a double-count of the same
activity. `summary`'s `longestSessionMinutes` is scoped to sessions whose
*start* falls in the filtered classification. `live` and `first-activity`
don't accept this param, same rationale as `dayType`.

## Work/leisure attribution (overview chart) and device attribution (live session)

Since v1.26 the overview chart (Totals and Timeline) is colored by **work
type**, not by device. Which device tracked the time no longer matters there;
device names only appear as text in tooltips and tables. Each device's
activity is classified first (by its own tracking-mode history, see
"Work/leisure filtering"). The pieces are then merged across devices into
disjoint `work` / `leisure` / `mixed` intervals (`mergeClassifiedSessions` in
`packages/core`). `mixed` only arises when two devices classified differently
are active at the same instant, because a single device is one type at any
moment. The categories add up to the plain all-devices total. If `?workType=`
is passed, only that type's pieces are merged, so no `mixed` can appear and
the numbers match the `?workType=` totals elsewhere. In the unfiltered view,
the work share of a stacked bar is therefore smaller than the `?workType=work`
total by exactly the mixed time, which the filtered view counts toward both
types.

Before v1.26 the Timeline was colored per device, with gray for overlaps.
Mixing identity and classification into one color channel had been rejected
back then. This is a replacement, not a mix: the user decided device identity
doesn't matter in this chart.

`GET /api/stats/live`'s `activeDeviceIds` and `/api/stats/sessions`'
`deviceIds` still use per-device attribution (`getAttributedSessionsInRange` /
`mergeSessionsWithDeviceIds`, sliced at the exact instant the active device
set changes). They show named devices as text, not colors.

## Resolved during implementation

- Dashboard auth: hand-rolled password + signed session cookie gate. See
  `docs/IMPLEMENTATION_NOTES.md` D3.
- `POST /api/auth/login` is rate-limited: 5 failed attempts per client
  (keyed by `X-Forwarded-For`) within a 15-minute window returns `429`
  until the window resets. Best-effort/in-memory (resets on a cold start),
  not a distributed rate limiter — sufficient for a single-user tool.
  The session cookie is only marked `Secure` when `NODE_ENV=production`
  (Vercel sets this on every deployment); local dev over plain HTTP needs
  it unset or the browser silently drops the cookie.
- Unhandled route errors (and malformed JSON bodies on `PUT
  /api/settings`, `POST /api/devices`, `POST /api/events`) return a
  generic `{ "error": "..." }` JSON response instead of throwing, so no
  route can 500 with an unstructured body.
