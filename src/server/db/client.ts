import { Pool } from "pg";
import { databaseUrl } from "../config.js";

let pool: Pool | undefined;

/** Lazily-created, process-wide connection pool (reused across invocations on a warm Vercel Function). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl() });
  }
  return pool;
}
