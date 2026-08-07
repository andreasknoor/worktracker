# WorkTracker

A personal work-time tracker: lightweight desktop trackers record keyboard/mouse
activity timestamps only (never key content or window titles), a Node.js/TypeScript
server turns those timestamps into work sessions, and a dashboard visualizes them.

## Architecture

```
Windows tracker ─┐
                  ├─ HTTPS, Authorization: Bearer <api-key> ─▶ Vercel Functions (Hono) ─▶ Postgres
Mac tracker      ─┘                                                   │
                                                                       ▼
                                                        Dashboard (static HTML/CSS/JS)
```

- **Server** (`src/server/`, `api/index.ts`) — a single Hono app bundled into one
  catch-all Vercel Function, covering event ingestion, stats, settings, and device
  management. See `docs/API_CONTRACT.md` for the exact endpoint shapes.
- **Core** (`packages/core/`) — pure, framework-free business logic: turning raw
  activity timestamps into sessions, daily/weekly/monthly aggregation, statistics.
  See `docs/SESSION_LOGIC_SPEC.md` for the session-detection rules.
- **Database** — Postgres (Vercel Marketplace, e.g. Neon). Schema in
  `src/server/db/schema.sql`.
- **Dashboard** (`public/`) — static HTML/CSS/JS, no framework or build step, served
  by Vercel and talking to the API via `fetch()`. Password-protected.
- **Mac tracker** (`mac-tracker/`) — native Swift/AppKit menu-bar app. Buildable and
  testable on macOS only; see `mac-tracker/README.md`.
- **Windows tracker** (`windows-tracker/`) — not yet implemented.

## Development

```sh
npm install
npm run build        # compiles packages/core
npm test              # runs the vitest suite (packages/core + src/server)
npm run typecheck
```

Copy `.env.example` to `.env.local` and fill in `DATABASE_URL`, `APP_TIME_ZONE`,
`DASHBOARD_PASSWORD`, and `DASHBOARD_SESSION_SECRET` for local development.

```sh
npm run db:apply-schema   # applies src/server/db/schema.sql to DATABASE_URL
```

Deployment is via the Vercel CLI/dashboard (`vercel.json` routes all `/api/*`
traffic to the single catch-all Function).

## Documentation

- `docs/CONCEPT.md` — architecture and stack rationale.
- `docs/DATA_MODEL.md` — entities and settings.
- `docs/SESSION_LOGIC_SPEC.md` — the business rules for turning raw activity
  timestamps into work sessions.
- `docs/API_CONTRACT.md` — REST endpoint shapes used by the dashboard.
- `docs/IMPLEMENTATION_NOTES.md` — decisions made during implementation,
  including where the build deviates from the original design docs.
