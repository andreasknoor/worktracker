# WorkTracker Client/Server Rewrite — Concept

## Background

WorkTracker is a personal work-time tracker. The original version is a fully local Windows-only .NET solution: a WinForms tray app polls `GetLastInputInfo` (keyboard/mouse activity timestamps only — never key content or window titles) and writes to a local SQLite file; an ASP.NET Core dashboard reads the same file and visualizes work sessions.

**This is now being rebuilt from scratch** as a client/server system:
- A Node.js/TypeScript server on Vercel (free Hobby plan) replaces the local SQLite + ASP.NET Core backend.
- The dashboard moves to Vercel too, kept as close as possible to its original HTML/CSS/JS design (see `dashboard-frontend/`).
- Multiple lightweight tracker clients (initially Windows + Mac) push activity events to the server over HTTPS, authenticated with per-device API keys.
- No code from the old .NET project is reused. Only its functional behavior (business rules, API shape, UI) is preserved, documented in this package.

## Why Vercel + Node.js (not a Vercel + .NET hybrid)

Vercel has no official .NET runtime. The alternatives — a custom Docker container on Vercel, or keeping .NET and duplicating the session-calculation logic in a second language — both trade one problem for a worse one: cold-start/billing uncertainty in the container case, or silent logic drift between two independently-maintained implementations of the same non-trivial business rule in the duplication case. Rewriting natively in Node.js/TypeScript (Vercel's first-class runtime) avoids both: one implementation, one language, no impedance mismatch with the platform.

The cost of this choice: the most valuable part of the old codebase — the session-calculation logic and its extensive test suite — has to be re-implemented and re-verified from scratch. This is deliberate and accepted; `SESSION_LOGIC_SPEC.md` and `reference-tests/` exist specifically to make sure that re-implementation is faithful and complete.

## Target architecture

```
┌──────────────────┐     ┌──────────────────┐
│ Windows tracker   │     │  Mac tracker     │
│ (built & tested   │     │  (built & tested │
│  on Windows only) │     │  on Mac)         │
└─────────┬─────────┘     └─────────┬────────┘
          │   HTTPS, Authorization: Bearer <api-key>
          └──────────────┬──────────────┘
                          ▼
             ┌─────────────────────────┐
             │  Vercel Functions       │
             │  (Node.js/TypeScript)   │
             │  - POST /api/events     │
             │  - GET  /api/stats/*    │
             │  - GET/PUT /api/settings│
             │  - /api/devices (CRUD)  │
             └────────────┬────────────┘
                          ▼
             ┌─────────────────────────┐
             │ Postgres (Vercel        │
             │ Marketplace, e.g. Neon, │
             │ free tier)              │
             └─────────────────────────┘
                          ▲
             ┌────────────┴────────────┐
             │ Dashboard (static HTML/ │
             │ CSS/JS, Vercel-hosted,  │
             │ behind auth)           │
             └─────────────────────────┘
```

**Stack:**
- Server: Node.js + TypeScript, deployed as Vercel Functions (officially supported runtime — no container experiments needed).
- Database: Postgres via the Vercel Marketplace (e.g. Neon free tier). Replaces the old SQLite file; Vercel Functions have a read-only filesystem (only `/tmp`, ephemeral, 500MB), so a local-file database is not an option server-side.
- Dashboard: static HTML/CSS/JS + hand-rolled SVG charts (no framework, no build step) — see `dashboard-frontend/`, carried over from the original almost unchanged. Talks to the server exclusively via the endpoints in `API_CONTRACT.md`.
- Windows tracker: minimal client, built/tested on Windows only (see `NOTES_FOR_MAC_BUILD.md`). Polls local activity, pushes events via HTTPS.
- Mac tracker: new, native to macOS (e.g. Swift/AppKit menu-bar app), analogous role to the Windows tracker.

## Data model

See `DATA_MODEL.md` for full schema. Summary: raw `activity_events` per device are the only persisted activity data — work sessions are always *derived* on read via the session-calculation logic, never stored. This preserves the original project's core principle: changing the idle threshold later recalculates history automatically, with no migration needed.

## Multi-device handling

Each tracker (Windows laptop, Mac laptop, future additions) registers as a `device` with its own API key. Activity events are tagged with `device_id`. For v1, the dashboard's stats aggregate across *all* devices as one combined activity stream (a work session is "you were active", regardless of which machine) — this matches the single-user, single-person intent of the tool. Device management (list/rename/revoke) is exposed via `/api/devices`.

Note: if both devices are ever used simultaneously, overlapping activity from two devices in the same time window should not double-count — merge overlapping/adjacent raw events across devices before running the session calculator, rather than computing sessions per-device and summing.

## API-key security — what it does and doesn't cover

Per-device API keys (server stores only a hash, analogous to password hashing) authenticate *which device is allowed to write events*, over HTTPS, and let compromised/lost devices be individually revoked. This is standard and sufficient for keeping unauthorized third parties from injecting fake activity data.

It does **not** prevent the account owner from editing their own data directly in the database or redeploying the server with different logic — that's not a security gap, it's just what "you own the server" means. If the actual goal is *tamper-evidence for yourself* (e.g. as a credible record toward an employer), API keys alone don't achieve that; it would need something like an append-only event log or client-side signing, which is out of scope for v1 unless explicitly requested.

The dashboard itself also needs its own access control once it's publicly reachable on a Vercel URL — this did not exist in the original (local-only) version and must be added new (e.g. a simple password gate or Vercel's built-in deployment protection).

## Vercel Hobby plan constraints to keep in mind

- Non-commercial, personal use only (fair-use policy) — fine for this use case, but worth remembering if usage patterns ever change.
- Function duration max 300s — irrelevant here, all requests are short.
- Cron jobs limited to once/day on Hobby — not needed; the tracker pushes events itself rather than the server polling.
- No persistent local filesystem — hence Postgres via Marketplace, not SQLite.
- 12 Vercel Functions per deployment without a meta-framework — the endpoint list above fits comfortably; if it grows, consider a lightweight framework (e.g. Next.js API routes or Hono) that bundles multiple routes into fewer functions.

## Phased build plan

1. **Server skeleton + Postgres schema** — project setup, DB provisioning, connection plumbing.
2. **Session/statistics logic** (`SESSION_LOGIC_SPEC.md`) + ported test suite (`reference-tests/`) — highest priority; this is the functional core and should be solid and independently verified before anything is built on top of it.
3. **API endpoints** (`API_CONTRACT.md`) + device/API-key management + dashboard auth.
4. **Dashboard frontend wiring** — connect `dashboard-frontend/` to the live API (should require minimal changes if the API contract is honored exactly).
5. **Windows tracker** — HTTP-push client; build/test on a Windows machine only.
6. **Mac tracker** — new native build; build/test on this Mac.

## Evaluation / risks to stay aware of during implementation

- **Biggest risk:** subtly getting the session-calculation rules wrong during re-implementation (especially the resume-confirmation-window and cross-range buffering rules — see `SESSION_LOGIC_SPEC.md`). Mitigate by porting `reference-tests/` before writing any endpoint that depends on the logic.
- **Second risk:** losing time-zone correctness. The original computes everything in the server's local time zone for day-boundary logic (midnight splits, "today"). Vercel Functions run in a fixed region (default `iad1`, US East) — decide explicitly whether "today"/day-boundaries should be computed in the user's local time zone (sent from the client) or a fixed server zone, since naively using the Vercel server's local time will silently produce wrong day boundaries for a user elsewhere.
- Multi-device overlap handling (see above) is a new problem that didn't exist in the single-device original — don't skip it, or totals will double-count when both trackers are active at once.
- Dashboard auth and device-management UI are both net-new surface area with no original counterpart to copy from.
