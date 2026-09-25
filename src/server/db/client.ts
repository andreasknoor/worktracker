import { Pool } from "pg";
import { databaseUrl } from "../config.js";

let pool: Pool | undefined;

/** Lazily-created, process-wide connection pool (reused across invocations on a warm Vercel Function). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      // Fail fast instead of hanging indefinitely (the default) when the
      // database is unreachable — e.g. Neon suspended for exceeding its
      // free-tier usage — so a single Function invocation can't tie up its
      // active CPU time waiting on a connection that will never succeed.
      connectionTimeoutMillis: 5000,
    });
    // node-postgres emits "error" on the pool whenever an idle client's
    // connection is dropped server-side (exactly what happens when Neon
    // suspends/kills connections for exceeding its limits). Without a
    // listener, that's an unhandled exception that crashes the warm
    // process — which this app's single-warm-instance design (see
    // CLAUDE.md) specifically relies on staying alive across invocations.
    // Losing it forces a full cold start (module load, TLS/JIT warmup) on
    // the next request, which is itself real active-CPU cost — so a DB
    // outage can inflate CPU usage instead of merely failing requests fast.
    pool.on("error", (err) => {
      console.error("Postgres pool error (idle client connection lost):", err);
    });
  }
  return pool;
}
