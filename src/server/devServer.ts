import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { getPool } from "./db/client.js";
import {
  PostgresActivityEventsRepository,
  PostgresDevicesRepository,
  PostgresSettingsRepository,
} from "./repositories/postgresRepositories.js";

// Local dev server, run against the real Neon Postgres database (same
// DATABASE_URL as production/preview, pulled into .env.local via
// `vercel env pull`). This exists because `vercel dev` doesn't reliably
// route requests in this project's zero-config (no meta-framework) setup —
// see docs/IMPLEMENTATION_NOTES.md. Not used for deployment; api/index.ts
// (the actual Vercel Function) is unaffected by this file.
const pool = getPool();
const app = createApp({
  devices: new PostgresDevicesRepository(pool),
  events: new PostgresActivityEventsRepository(pool),
  settings: new PostgresSettingsRepository(pool),
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`WorkTracker dev server: http://localhost:${info.port}`);
});
