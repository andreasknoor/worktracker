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
  "days": [{ "date": "2026-03-09", "hours": 7.5 }, ...]
}
```

### `GET /api/stats/week-timeline?start=yyyy-MM-dd`
Same week window, but per-day clock-time segments instead of totals (for the "Timeline" chart mode). Each segment additionally carries `deviceIds`: the device(s) active during that exact sub-slice — one id if only one device was active, two or more if they overlapped (used to color the aggregated Timeline chart per device, with a neutral color for the multi-device case; see "Device attribution" below).
```json
{
  "weekStart": "2026-03-09",
  "weekEndExclusive": "2026-03-16",
  "days": [
    {
      "date": "2026-03-09",
      "segments": [
        { "startMinutes": 540, "endMinutes": 690, "deviceIds": ["a1b2..."] },
        { "startMinutes": 690, "endMinutes": 720, "deviceIds": ["a1b2...", "c3d4..."] },
        { "startMinutes": 780, "endMinutes": 1020, "deviceIds": ["c3d4..."] }
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
  "days": [{ "date": "2026-02-01", "hours": 0 }, ...]
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

### `GET /api/stats/sessions?days={n}` (default 7)
Individual sessions in `[today+1-days, today+1)`, most recent first.
```json
[
  { "date": "2026-03-11", "start": "09:02", "end": "12:47", "durationMinutes": 225 },
  ...
]
```

### `GET /api/stats/live`
Polled every 15s by the dashboard for the live ring/timer.
```json
{ "isActive": true, "todaySeconds": 14520, "currentSessionSeconds": 1830 }
```

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

### `GET /api/settings/`
```json
{
  "coreHoursStart": "09:00",
  "coreHoursEnd": "18:00",
  "deviceStaleThresholdHours": 24
}
```

### `PUT /api/settings/`
Request body same shape as the `GET` response. Validation:
- `coreHoursStart`/`coreHoursEnd` must parse as `HH:mm`, else `400`.
- `coreHoursEnd` must be strictly after `coreHoursStart`, else `400`.
- `deviceStaleThresholdHours` must be a positive number, else `400`.
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
- `401` if the API key is missing/invalid/revoked.
- `400` if the batch exceeds 5000 timestamps in one request, or if none of the provided timestamps parse.
- Server resolves the key to a `device_id`, inserts one row per timestamp into `activity_events`, and updates that device's `last_seen_at`.
- `200`/`201` with an empty or minimal ack body — trackers don't need a rich response.

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
Request: `{ "idleThresholdMinutes"?: number, "pollIntervalSeconds"?: number, "trackingMode"?: "auto" | "alwaysWork" | "alwaysLeisure" }` (any subset). `idleThresholdMinutes`/`pollIntervalSeconds`, if present, must be `> 0`; `trackingMode`, if present, must be one of the three listed values — else `400`. `404` if the id isn't a valid uuid or doesn't match a device. Returns the updated device (same shape as one `GET /api/devices` entry, minus `apiKey`).

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

`GET /api/stats/week`, `/week-timeline`, `/month`, `/summary`, and
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
/api/stats/week`, `/week-timeline`, `/month`, `/summary`, and `/sessions`
additionally accept `?workType=work|leisure|all` (default `all`; `400` on an
unrecognized value). `dayType` and `workType` can be combined — they're
applied independently, not as alternatives.

Classification is per device, per calendar day, via each device's
`trackingMode` (see the devices section above), *not* a raw weekday/weekend
check on the query range as a whole:
- `auto` (the default): weekday → work, weekend → leisure.
- `alwaysWork` / `alwaysLeisure`: pins that device's time regardless of day —
  e.g. a company PC whose weekend activity should still count as work.

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

## Device attribution (Timeline chart, dimension 1)

`GET /api/stats/week-timeline`'s `deviceIds` field (see above) lets the
dashboard color the aggregated Timeline chart per device, with a neutral
color wherever `deviceIds.length >= 2` (devices genuinely active at the same
instant — sliced at the exact overlap boundary, not the whole span each
session happened to touch). This is independent of `workType`: it's an
identity axis (whose activity is this), not a classification axis (what kind
of time is this) — mixing the two into one color channel was considered and
deliberately rejected, since a device left on `auto` would need its color to
mean two different things at once. If `?workType=` is also passed, the
attributed sessions are computed *within* that classification bucket first,
so the Timeline chart's device colors reflect only the currently filtered
work/leisure slice.

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
  /api/settings/`, `POST /api/devices`, `POST /api/events`) return a
  generic `{ "error": "..." }` JSON response instead of throwing, so no
  route can 500 with an unstructured body.
