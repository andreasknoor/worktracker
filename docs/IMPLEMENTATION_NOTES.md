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
catch-all Vercel Function (`api/[[...path]].ts`), which removes the limit
entirely and lets all endpoints share a warm instance (relevant since the
dashboard polls `/api/stats/live` every 15s).

## Multi-device double-counting test coverage

`test/routes/devices.test.ts`'s "Multi-device overlap handling" test seeds
two devices with fully overlapping 09:00–10:00 activity and asserts the
summed total reads as ~1 hour, not ~2 — directly covering the risk called
out in `CONCEPT.md`.

## Not yet implemented (flagged in `API_CONTRACT.md`, still open)

- Optional `deviceId` filter on stats endpoints, to view one machine's
  activity separately from the combined stream. Left out of v1.
