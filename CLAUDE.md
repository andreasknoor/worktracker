# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WorkTracker is a personal work-time tracker: lightweight desktop trackers record
keyboard/mouse activity timestamps only (never key content or window titles), a
Node.js/TypeScript server turns those timestamps into work sessions, and a
dashboard visualizes them.

```
Windows tracker ─┐
                  ├─ HTTPS, Authorization: Bearer <api-key> ─▶ Vercel Functions (Hono) ─▶ Postgres
Mac tracker      ─┘                                                   │
                                                                       ▼
                                                        Dashboard (static HTML/CSS/JS)
```

- **`packages/core/`** — pure, framework-free business logic: turning raw activity
  timestamps into sessions, daily/weekly/monthly aggregation, statistics. No I/O.
  See `docs/SESSION_LOGIC_SPEC.md` for the session-detection rules.
- **`src/server/`** + **`api/index.ts`** — a single Hono app bundled into one
  catch-all Vercel Function, covering event ingestion, stats, settings, and device
  management. See `docs/API_CONTRACT.md` for exact endpoint shapes.
- **`public/`** — the dashboard: static HTML/CSS/JS, no framework or build step,
  served by Vercel and talking to the API via `fetch()`. Password-protected.
- **`mac-tracker/`** — native Swift/AppKit menu-bar app. Buildable and testable on
  macOS only.
- **`windows-tracker/`** — not yet implemented (placeholder directory).

## Commands

```sh
npm install
npm run build        # compiles packages/core (must happen before api/ can import it)
npm test              # runs the vitest suite (packages/core + src/server)
npm run test:watch
npm run typecheck     # tsc --noEmit on both the root project and packages/core
npx vitest run test/routes/devices.test.ts   # single test file
npx vitest run -t "test name substring"      # single test by name
```

Local dev environment:

```sh
cp .env.example .env.local   # or: vercel env pull .env.local (if linked to Vercel)
npm run db:apply-schema      # applies src/server/db/schema.sql to DATABASE_URL
npm run dev                  # local server + dashboard at http://localhost:3000
```

`npm run dev` runs `src/server/devServer.ts` (a plain Node HTTP server via
`@hono/node-server`), **not** `vercel dev` — `vercel dev` doesn't reliably route
requests in this project's zero-config (no meta-framework) layout (see
`docs/IMPLEMENTATION_NOTES.md`). It reuses the exact same `createApp()` and
Postgres repositories as production. Pointing `.env.local`'s `DATABASE_URL` at
the same Neon database as production means local testing writes real rows
there.

Mac tracker (run from `mac-tracker/`):

```sh
swift build
swift test    # requires the full Xcode toolchain's XCTest.framework; if
               # `xcode-select -p` points at CommandLineTools, prefix with
               # DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
./build-app.sh && open dist/WorkTrackerTracker.app   # run as a real .app bundle,
               # not `swift run` — a bundle-less process has no
               # CFBundleIdentifier and the menu-bar icon often fails to render
```

## Architecture notes worth knowing before changing code

- **Session calculation** (`packages/core/src/sessionCalculator.ts`,
  `calculateSessions`): a gap between consecutive timestamps larger than
  `idleThreshold` ends a session; the event after such a gap only starts a new
  session if a further event confirms it within `resumeConfirmationWindow`,
  otherwise it's dropped as noise without moving the idle-gap anchor. Full rule
  set in `docs/SESSION_LOGIC_SPEC.md`.
- **Per-device settings, not global.** `idleThresholdMinutes` and
  `pollIntervalSeconds` live on each `devices` row, not in the global
  `settings` table — each tracker installation is tuned independently.
  Consequently sessions are computed **per device** (each with its own idle
  threshold and effective resume-confirmation window) and then merged across
  devices via `mergeSessions()`, which unions overlapping/touching (`gap <= 0`)
  session intervals — this is what prevents double-counting when two devices
  are active simultaneously.
- **`?deviceId=` filter** on all `/api/stats/*` endpoints scopes results to one
  device instead of the merged all-devices view (`resolveDeviceIdFilter` in
  `src/server/app.ts`). It validates the id against the devices repository, not
  just uuid syntax, so a stale id (e.g. a just-revoked device still cached in
  the dashboard's `localStorage`) returns `404` instead of silently-empty data.
- **Repositories are an interface** (`src/server/repositories/types.ts`):
  `PostgresDevicesRepository`/`PostgresActivityEventsRepository`/`PostgresSettingsRepository`
  for real use, `InMemory*` equivalents for tests — route tests exercise the
  Hono app in-process via `app.request(...)` against the in-memory repos.
- **Single catch-all Vercel Function.** All routes are bundled into one Hono
  app served by `api/index.ts`, not one file per endpoint — Vercel Hobby caps
  "one file = one Function" deployments at 12 Functions, and a single warm
  instance matters since the dashboard polls `/api/stats/live` every 15s.
  `vercel.json` rewrites `/api/:path*` → `/api`.
- **Time zone**: a single `APP_TIME_ZONE` env var (IANA, e.g. `Europe/Berlin`)
  is threaded explicitly through every day-boundary computation in
  `packages/core` — never rely on the process's local time zone, since Vercel
  Functions run in a fixed region. Defaults to `Europe/Berlin` in
  `src/server/config.ts`.
- **Dashboard auth** is hand-rolled, not a Vercel platform feature (Password
  Protection isn't available on Hobby; free "Vercel Authentication" never
  covers the production domain). `src/server/auth.ts`: constant-time compare
  against `DASHBOARD_PASSWORD`, backed by an HMAC-signed session cookie
  (`DASHBOARD_SESSION_SECRET`, `wtk_session`, 30-day TTL). `/api/events` and
  `/api/auth/login` are excluded from the gate; every other `/api/*` route
  requires it — note the middleware must be registered on **both** the exact
  path and its `/*` sub-path form (`app.use("/api/devices", ...)` and
  `app.use("/api/devices/*", ...)`), since Hono's glued-wildcard form
  (`"/api/devices*"`) only matches the exact base path, not sub-paths — a real
  auth bypass was previously shipped this way on `PATCH`/`DELETE
  /api/devices/:id`.
- Sessions spanning midnight in `/api/stats/sessions` are split into one row
  per day touched (reusing the timeline chart's `dailySegments` clipping
  logic); a session ending exactly at midnight formats as `"24:00"`.

## Documentation

- `docs/CONCEPT.md` — architecture and stack rationale.
- `docs/DATA_MODEL.md` — entities and settings.
- `docs/SESSION_LOGIC_SPEC.md` — the business rules for turning raw activity
  timestamps into work sessions.
- `docs/API_CONTRACT.md` — REST endpoint shapes used by the dashboard.
- `docs/IMPLEMENTATION_NOTES.md` — decisions made during implementation,
  including deviations from the original design docs and bugs that were only
  caught by testing the live deployment (worth reading before touching
  routing, auth middleware, or the Mac tracker's UI shell).
