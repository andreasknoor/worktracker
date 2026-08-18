/** Central place for reading environment-driven configuration. */

/**
 * App version, shown in the dashboard header and returned by `GET
 * /api/version`. Keep this in sync with `package.json`'s `version` field —
 * they're two separate constants (not one JSON import) because this file
 * runs directly in Vercel's per-file Node Function build, which doesn't
 * guarantee a working-directory-relative file read of package.json at
 * runtime.
 *
 * Versioning policy: "normal" changes bump the minor number (1.0 -> 1.1 ->
 * 1.2 -> ...); a major bump (-> 2.0, resetting minor to 0) only happens when
 * explicitly requested.
 */
export const APP_VERSION = "1.12";

/**
 * IANA time zone used for every day-boundary computation ("today", midnight
 * splits, week/month ranges). Vercel Functions run in a fixed region (UTC
 * process time), so this must be set explicitly rather than relying on the
 * server's local time zone. See CONCEPT.md's time-zone risk note.
 */
export function appTimeZone(): string {
  return process.env.APP_TIME_ZONE ?? "Europe/Berlin";
}

/** Shared dashboard password. Required in production; unset only in local dev/test. */
export function dashboardPassword(): string | undefined {
  return process.env.DASHBOARD_PASSWORD;
}

/** Secret used to HMAC-sign the dashboard session cookie. */
export function dashboardSessionSecret(): string {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) {
    throw new Error("DASHBOARD_SESSION_SECRET environment variable is not set");
  }
  return secret;
}

/**
 * True when running as the deployed Vercel Function (Vercel always sets
 * NODE_ENV=production for both production and preview deployments — both
 * serve over HTTPS). False for local dev (`npm run dev`, no NODE_ENV set)
 * and tests, where the session cookie must NOT be marked `Secure` or
 * browsers silently drop it over plain HTTP, breaking login locally.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return url;
}
