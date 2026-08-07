import { handle } from "hono/vercel";
import { createApp } from "../src/server/app.js";
import { getPool } from "../src/server/db/client.js";
import {
  PostgresActivityEventsRepository,
  PostgresDevicesRepository,
  PostgresSettingsRepository,
} from "../src/server/repositories/postgresRepositories.js";

// Single catch-all Vercel Function bundling every API route behind one Hono
// app, instead of one file per endpoint. Hobby's per-deployment Function
// count is limited (framework-less "one file = one Function" deployments cap
// out at 12 — see docs/IMPLEMENTATION_NOTES.md), and this pattern removes
// that ceiling entirely while also sharing a warm instance across all
// endpoints, which matters for a dashboard polling /api/stats/live every 15s.
const pool = getPool();
const app = createApp({
  devices: new PostgresDevicesRepository(pool),
  events: new PostgresActivityEventsRepository(pool),
  settings: new PostgresSettingsRepository(pool),
});

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
