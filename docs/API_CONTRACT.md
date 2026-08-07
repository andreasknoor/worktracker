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
Same week window, but per-day clock-time segments instead of totals (for the "Timeline" chart mode).
```json
{
  "weekStart": "2026-03-09",
  "weekEndExclusive": "2026-03-16",
  "days": [
    {
      "date": "2026-03-09",
      "segments": [{ "startMinutes": 540, "endMinutes": 720 }, { "startMinutes": 780, "endMinutes": 1020 }]
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

### `GET /api/settings/`
```json
{
  "idleThresholdMinutes": 30,
  "pollIntervalSeconds": 30,
  "startWithWindows": true,
  "coreHoursStart": "09:00",
  "coreHoursEnd": "18:00"
}
```
Note: `startWithWindows` is carried over from the original single-device shape. In the multi-device model this field's meaning is ambiguous (which device?) — decide during implementation whether to drop it from the global settings response (and remove the corresponding dashboard toggle) or repurpose it as a per-*current-viewing-context* convenience. See `DATA_MODEL.md`'s note on this.

### `PUT /api/settings/`
Request body same shape as the `GET` response. Validation (preserve these exact rules):
- `idleThresholdMinutes > 0` and `pollIntervalSeconds > 0`, else `400`.
- `coreHoursStart`/`coreHoursEnd` must parse as `HH:mm`, else `400`.
- `coreHoursEnd` must be strictly after `coreHoursStart`, else `400`.

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
- Server resolves the key to a `device_id`, inserts one row per timestamp into `activity_events`, and updates that device's `last_seen_at`.
- `200`/`201` with an empty or minimal ack body — trackers don't need a rich response.

## Device management (new — dashboard admin UI, not yet in the original prototype)

### `GET /api/devices`
```json
[
  { "id": "...", "name": "Work Laptop (Windows)", "platform": "windows", "lastSeenAt": "2026-03-11T09:02:45Z", "revoked": false },
  ...
]
```

### `POST /api/devices`
Request: `{ "name": "...", "platform": "windows" | "mac" }`. Response includes the **raw** API key exactly once (never retrievable again, same convention as GitHub/Stripe-style tokens):
```json
{ "id": "...", "name": "...", "platform": "windows", "apiKey": "wtk_live_..." }
```

### `DELETE /api/devices/{id}`
Revokes the device's key (soft-revoke — see `DATA_MODEL.md`). `204` on success.

## Per-device filtering

All `/api/stats/*` endpoints accept an optional `?deviceId=` query param,
scoping the result to a single device instead of the merged all-devices view.
An unknown or malformed id returns `404` rather than silently empty data. See
`docs/IMPLEMENTATION_NOTES.md`.

## Resolved during implementation

- Dashboard auth: hand-rolled password + signed session cookie gate. See
  `docs/IMPLEMENTATION_NOTES.md` D3.
