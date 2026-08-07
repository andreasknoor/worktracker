// One-off helper: applies src/server/db/schema.sql to DATABASE_URL.
// Usage: DATABASE_URL=... node scripts/apply-schema.mjs
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const schema = readFileSync(new URL("../src/server/db/schema.sql", import.meta.url), "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(schema);
  console.log("Schema applied successfully.");
} finally {
  await pool.end();
}
