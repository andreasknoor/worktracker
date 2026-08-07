# Implementation Notes — Deviations From the Handoff Package

This file tracks decisions made during implementation that deviate from, or
resolve open questions in, `README.md`, `CONCEPT.md`, `DATA_MODEL.md`,
`SESSION_LOGIC_SPEC.md`, and `API_CONTRACT.md`. Those files describe the
original plan; this file describes what actually got built and why, where it
differs.

## Per-device settings (idle threshold, poll interval)

**Decision:** `idleThresholdMinutes` and `pollIntervalSeconds` moved from the
global `settings` table to per-device columns on `devices`. Each tracker
installation can now be tuned independently.

**Why:** Requested during implementation — the original handoff package
assumed one global idle threshold. `CoreHoursStart`/`CoreHoursEnd` remain
global (dashboard-display concerns), and `startWithWindows` was dropped
entirely (see below).

**Consequence — session merging changed.** `CONCEPT.md`'s multi-device note
says to "merge overlapping/adjacent raw events across devices before running
the session calculator." That only works if all devices share one idle
threshold. With per-device thresholds, there's no single threshold a merged
raw-timestamp stream could be evaluated under. Instead:

1. Sessions are computed **per device**, each using that device's own idle
   threshold and its own effective resume-confirmation window
   (`effectiveResumeConfirmationWindow`, based on that device's poll interval).
2. The resulting per-device session lists are merged via
   `mergeSessions()` (`packages/core/src/sessionCalculator.ts`), which unions
   overlapping or touching (`gap <= 0`) session intervals across devices.

This still satisfies the "no double-counting when both devices are active
simultaneously" requirement (see the `mergeSessions` tests and
`test/routes/devices.test.ts`'s multi-device overlap test), just at the
session level instead of the raw-event level.

## D1 — Time zone

Single `APP_TIME_ZONE` env var (IANA, e.g. `Europe/Berlin`), threaded
explicitly through every day-boundary computation in `packages/core` (never
relying on the process's local time zone, since Vercel Functions run in a
fixed region). Defaults to `Europe/Berlin` in `src/server/config.ts` if unset.

## D2 — `startWithWindows`

Dropped entirely from `GET/PUT /api/settings/` and the dashboard UI.
Autostart is a purely local, per-OS tracker concern with no server-side
meaning in a multi-device model.

## D3 — Dashboard auth

**Verified against current Vercel docs:** Password Protection is not
available on the Hobby plan at all (Enterprise, or a paid Pro add-on only),
and Hobby's free "Vercel Authentication" never covers the production domain
— only preview/deployment URLs. So there is no platform-level way to gate a
Hobby production dashboard.

**Implementation:** hand-rolled gate in `src/server/auth.ts` — a single
shared secret (`DASHBOARD_PASSWORD` env var) compared in constant time,
backed by a stateless HMAC-signed session cookie (`DASHBOARD_SESSION_SECRET`
env var, `wtk_session` cookie, 30-day TTL). `/api/events` (device ingestion)
and `/api/auth/login` are excluded from the gate; every other `/api/*` route
requires a valid session cookie. The frontend (`public/js/app.js`) probes
`/api/stats/first-activity` on load and shows a login overlay on `401`.

## D4 — Sessions spanning midnight in `/api/stats/sessions`

Reused the same day-clipping logic as the timeline chart
(`dailySegments`): a session spanning midnight is split into one row per
day it touches, each with its own clipped `start`/`end`. A session ending
exactly at midnight formats as `"24:00"` for that day's row.

## 12-Function limit (Hobby)

Verified against current Vercel docs: real, and it applies specifically to
"one file in `api/` = one Function" deployments without a meta-framework —
Hobby caps that at 12. Rather than approach that ceiling with one file per
endpoint, all routes are bundled into a single Hono app served by one
catch-all Vercel Function (`api/index.ts`, see below for why it isn't
`api/[[...path]].ts`), which removes the limit entirely and lets all
endpoints share a warm instance (relevant since the dashboard polls
`/api/stats/live` every 15s).

## Multi-device double-counting test coverage

`test/routes/devices.test.ts`'s "Multi-device overlap handling" test seeds
two devices with fully overlapping 09:00–10:00 activity and asserts the
summed total reads as ~1 hour, not ~2 — directly covering the risk called
out in `CONCEPT.md`.

## Bugs found only by testing the live deployment (not caught by the test suite)

The route tests exercise the Hono app in-process (`app.request(...)`) and
never caught these — they're specific to how Vercel routes real HTTP
requests to the deployed function, or to using a real Postgres instance
instead of the in-memory fakes. Recorded here because they're easy to
reintroduce if the routing or middleware setup changes again.

- **`@worktracker/core` had no build step.** Its `package.json` pointed
  `main`/`types` at raw `.ts` source. Vercel's function bundler leaves
  workspace dependencies for Node's runtime `import` resolution instead of
  inlining them, and Node can't load `.ts` files — every request that
  touched core logic crashed with `ERR_MODULE_NOT_FOUND`. Fixed by adding a
  `build` script (`tsc`) to `packages/core` and a root `build` script that
  Vercel now runs before bundling `api/`.
- **GET requests to multi-segment `/api/*` paths never reached the
  function.** The file was originally `api/[[...path]].ts`. In this
  zero-config (no meta-framework) deployment mode, Vercel's auto-generated
  route for that filename only matched a single path segment
  (`^/api/([^/]+)$`), so e.g. `/api/stats/first-activity` fell through to
  Vercel's own 404 page while single-segment paths like `/api/events`
  worked. Fixed by renaming to `api/index.ts` and adding an explicit
  `vercel.json` rewrite (`/api/:path*` → `/api`) whose destination now
  resolves to a real function.
- **Auth bypass on `/api/devices/:id`.** The dashboard-session middleware
  was registered as `app.use("/api/devices*", ...)` — without a slash before
  the wildcard, Hono only matches that pattern against the *exact* base
  path, not sub-paths. `PATCH`/`DELETE /api/devices/:id` silently skipped
  the middleware and ran fully unauthenticated. Found by `curl`-testing the
  live deployment without a session cookie and watching a device actually
  get revoked. Fixed by registering both the exact path and the `/*`
  sub-path form for `stats`, `settings`, and `devices`, with regression
  tests added in `test/routes/devices.test.ts`.
- **Malformed device IDs crashed with a raw Postgres error (500).** A
  non-UUID `:id` reached `PostgresDevicesRepository` and Postgres rejected
  the query with `invalid input syntax for type uuid`. Fixed with a UUID
  format check before hitting the repository, returning a normal 404.

## D5 — Per-device stats filtering

Added after v1: all `/api/stats/*` endpoints accept an optional `?deviceId=`
query param, scoping the session calculation to a single device instead of
the merged all-devices view. `resolveDeviceIdFilter` in `src/server/app.ts`
validates the id against the devices repository (not just uuid syntax), so a
stale id — e.g. a device just revoked/removed, still cached in the
dashboard's `localStorage` — surfaces as a `404` the frontend can react to,
rather than silently returning an empty "all zeros" result. The dashboard
header has a matching device dropdown backed by `GET /api/devices`.

## Mac tracker: menu-bar icon invisible when run via `swift run`

Not caught by the unit test suite (it only exercises `Config`,
`shouldRecordActivity`, and `ActivityQueue` against fakes — no real AppKit
UI). Found by actually running the app: launching the raw SwiftPM
executable (`swift run` / the binary in `.build/`) starts the process fine,
but the menu-bar icon often doesn't render. The unified system log showed
`[com.apple.AppKit:WindowTab] Cannot index window tabs due to missing main
bundle identifier` — a bundle-less process has no `CFBundleIdentifier`, and
Control Center's status-item scene registration can silently fail to draw
an icon without one, even though the XPC handshake with
`com.apple.controlcenter.statusitems` completes. Fixed by adding
`mac-tracker/Info.plist` and `mac-tracker/build-app.sh`, which packages the
built binary into a proper `dist/WorkTrackerTracker.app` (`LSUIElement` true
to stay out of the Dock). Run via `open dist/WorkTrackerTracker.app`, not
`swift run`. Confirmed fixed via `lsappinfo`, which now shows the process
registered under `com.worktracker.tracker` / "WorkTracker" instead of
anonymously.

## Not yet implemented

- Windows tracker (`windows-tracker/` is a placeholder directory). Only the
  Mac tracker (`mac-tracker/`) exists so far.
