/** Central place for reading environment-driven configuration. */

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

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return url;
}
