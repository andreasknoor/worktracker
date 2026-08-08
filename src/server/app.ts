import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  addDays,
  dailyHours,
  dailySegments,
  formatHHmm,
  liveView,
  mondayOnOrBefore,
  monthEndExclusive,
  monthStart,
  summary,
  type DateKey,
} from "@worktracker/core";
import {
  DASHBOARD_SESSION_COOKIE,
  createSessionToken,
  generateApiKey,
  hashApiKey,
  verifyDashboardPassword,
  verifySessionToken,
} from "./auth.js";
import { appTimeZone, isProduction } from "./config.js";
import type { ActivityEventsRepository, DevicesRepository, SettingsRepository } from "./repositories/types.js";
import { getMergedSessionsInRange } from "./services/sessionsService.js";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Bounds for the `?days=` window used by /api/stats/summary and /api/stats/sessions. */
const MIN_DAYS_PARAM = 1;
const MAX_DAYS_PARAM = 366;

/** A device can send at most this many raw timestamps in a single /api/events request. */
const MAX_EVENTS_PER_REQUEST = 5000;

/** Device display names are user-controlled input rendered in the dashboard UI. */
const MAX_DEVICE_NAME_LENGTH = 100;

function isValidDateKey(value: string | undefined): value is DateKey {
  if (!value || !DATE_KEY_PATTERN.test(value)) return false;
  // Reject calendar-invalid dates like "2024-02-30" (Date.UTC would otherwise
  // silently roll over into March).
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return roundTrip.getUTCFullYear() === y && roundTrip.getUTCMonth() === m - 1 && roundTrip.getUTCDate() === d;
}

/** Parses and bounds-checks the `?days=` query param, returning an error Response on failure. */
function parseDaysParam(c: Context, defaultDays = 7): number | Response {
  const raw = c.req.query("days");
  if (raw === undefined) return defaultDays;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < MIN_DAYS_PARAM || days > MAX_DAYS_PARAM) {
    return c.json({ error: `days must be an integer between ${MIN_DAYS_PARAM} and ${MAX_DAYS_PARAM}` }, 400);
  }
  return days;
}

// ---------- Login rate limiting ----------
//
// Best-effort, in-memory, per-warm-instance protection against password
// brute-forcing on the single shared dashboard password. State resets on
// cold start, which is an accepted trade-off for a personal single-user
// tool — the goal is to slow down casual brute-forcing, not to be a
// bulletproof distributed rate limiter.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

function loginClientKey(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export interface AppDependencies {
  devices: DevicesRepository;
  events: ActivityEventsRepository;
  settings: SettingsRepository;
}

function isoDateKey(d: Date): DateKey {
  return d.toISOString().slice(0, 10);
}

function minutesToHHmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, minutes));
  const h = Math.floor(clamped / 60);
  const m = Math.round(clamped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Reads the optional `?deviceId=` filter used to scope a stats endpoint to
 * one device instead of the combined all-devices view. Validates the id
 * against the devices repository (not just uuid syntax) so a stale id — e.g.
 * a device the user just revoked/removed, still cached in the dashboard's
 * localStorage — surfaces as a clear 404 the frontend can react to, rather
 * than silently returning an empty "all zeros" result.
 */
async function resolveDeviceIdFilter(c: Context, devicesRepo: DevicesRepository): Promise<string | undefined | Response> {
  const deviceId = c.req.query("deviceId");
  if (!deviceId) return undefined;

  const device = await devicesRepo.getById(deviceId);
  if (!device) return c.json({ error: "Unknown deviceId" }, 404);

  return deviceId;
}

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();
  const timeZone = appTimeZone();
  const loginAttempts = new Map<string, { count: number; windowStart: number }>();

  const isLoginRateLimited = (key: string, nowMs: number): boolean => {
    const entry = loginAttempts.get(key);
    if (!entry) return false;
    if (nowMs - entry.windowStart > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
      return false;
    }
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  };

  const recordFailedLogin = (key: string, nowMs: number): void => {
    const entry = loginAttempts.get(key);
    if (!entry || nowMs - entry.windowStart > LOGIN_WINDOW_MS) {
      loginAttempts.set(key, { count: 1, windowStart: nowMs });
      return;
    }
    entry.count += 1;
  };

  // ---------- Dashboard auth ----------

  app.post("/api/auth/login", async (c) => {
    const clientKey = loginClientKey(c);
    const now = Date.now();
    if (isLoginRateLimited(clientKey, now)) {
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }

    const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
    if (!body.password || !verifyDashboardPassword(body.password)) {
      recordFailedLogin(clientKey, now);
      return c.json({ error: "Invalid password" }, 401);
    }

    loginAttempts.delete(clientKey);
    setCookie(c, DASHBOARD_SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "Strict",
      path: "/",
    });
    return c.json({ ok: true });
  });

  const requireDashboardSession = async (c: Context, next: Next) => {
    if (!verifySessionToken(getCookie(c, DASHBOARD_SESSION_COOKIE))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };

  // A pattern like "/api/devices*" (no slash before the wildcard) only
  // matches the exact base path in Hono, NOT sub-paths like
  // "/api/devices/:id" — that gap previously let PATCH/DELETE requests reach
  // their handlers unauthenticated. Registering both the exact path and the
  // "/*" sub-path form avoids relying on that glued-wildcard behavior.
  app.use("/api/stats", requireDashboardSession);
  app.use("/api/stats/*", requireDashboardSession);
  app.use("/api/settings", requireDashboardSession);
  app.use("/api/settings/*", requireDashboardSession);
  app.use("/api/devices", requireDashboardSession);
  app.use("/api/devices/*", requireDashboardSession);

  // ---------- Stats ----------

  app.get("/api/stats/week", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const start = c.req.query("start");
    if (!isValidDateKey(start)) {
      return c.json({ error: "start must be a valid yyyy-MM-dd date" }, 400);
    }
    const endExclusive = addDays(start, 7);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
      deviceId,
    );
    const daily = dailyHours(sessions, start, endExclusive, timeZone);

    return c.json({
      weekStart: start,
      weekEndExclusive: endExclusive,
      days: daily.map((d) => ({ date: d.date, hours: d.workedTimeMs / 3_600_000 })),
    });
  });

  app.get("/api/stats/week-timeline", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const start = c.req.query("start");
    if (!isValidDateKey(start)) {
      return c.json({ error: "start must be a valid yyyy-MM-dd date" }, 400);
    }
    const endExclusive = addDays(start, 7);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
      deviceId,
    );
    const segments = dailySegments(sessions, start, endExclusive, timeZone);

    return c.json({
      weekStart: start,
      weekEndExclusive: endExclusive,
      days: segments.map((d) => ({ date: d.date, segments: d.segments })),
    });
  });

  app.get("/api/stats/month", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const monthAnyDate = c.req.query("month");
    if (!isValidDateKey(monthAnyDate)) {
      return c.json({ error: "month must be a valid yyyy-MM-dd date" }, 400);
    }
    const start = monthStart(monthAnyDate);
    const endExclusive = monthEndExclusive(monthAnyDate);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
      deviceId,
    );
    const daily = dailyHours(sessions, start, endExclusive, timeZone);

    return c.json({
      monthStart: start,
      monthEndExclusive: endExclusive,
      days: daily.map((d) => ({ date: d.date, hours: d.workedTimeMs / 3_600_000 })),
    });
  });

  app.get("/api/stats/summary", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const days = parseDaysParam(c);
    if (days instanceof Response) return days;

    const endParam = c.req.query("end");
    if (endParam !== undefined && !isValidDateKey(endParam)) {
      return c.json({ error: "end must be a valid yyyy-MM-dd date" }, 400);
    }
    const endExclusive = endParam ?? isoDateKey(addOneDay(new Date()));
    const start = addDays(endExclusive, -days);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
      deviceId,
    );
    const daily = dailyHours(sessions, start, endExclusive, timeZone);
    const periodSummary = summary(sessions, daily);

    return c.json({
      totalHours: periodSummary.totalWorkedTimeMs / 3_600_000,
      activeDayCount: periodSummary.activeDayCount,
      rangeDayCount: days,
      averageHoursPerActiveDay: periodSummary.averageWorkedTimePerActiveDayMs / 3_600_000,
      longestSessionMinutes: periodSummary.longestSessionMs / 60_000,
      daily: daily.map((d) => ({ date: d.date, hours: d.workedTimeMs / 3_600_000 })),
    });
  });

  app.get("/api/stats/sessions", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const days = parseDaysParam(c);
    if (days instanceof Response) return days;

    const endExclusive = isoDateKey(addOneDay(new Date()));
    const start = addDays(endExclusive, -days);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
      deviceId,
    );

    // Each session is split into per-day clock-time chunks (reusing the same
    // midnight-clipping logic as the timeline chart), so a session spanning
    // midnight shows up as one row per day it touches — see D4 in
    // docs/IMPLEMENTATION_NOTES.md.
    const segments = dailySegments(sessions, start, endExclusive, timeZone);
    const rows = segments.flatMap((day) =>
      day.segments.map((s) => ({
        date: day.date,
        start: minutesToHHmm(s.startMinutes),
        end: minutesToHHmm(s.endMinutes),
        durationMinutes: s.endMinutes - s.startMinutes,
      })),
    );
    rows.sort((a, b) => (a.date === b.date ? b.start.localeCompare(a.start) : b.date.localeCompare(a.date)));

    return c.json(rows);
  });

  app.get("/api/stats/live", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const now = Date.now();
    const todayKey = isoDateKey(new Date(now));
    // Buffer well past any device's idle threshold so the session that's
    // potentially still running is fully captured.
    const bufferedStart = Date.parse(addDays(todayKey, -1) + "T00:00:00Z");

    const sessions = await getMergedSessionsInRange(deps.devices, deps.events, bufferedStart, now + 1, deviceId);

    const allDevices = await deps.devices.list();
    const relevantDevices = deviceId ? allDevices.filter((d) => d.id === deviceId) : allDevices;
    const maxIdleThresholdMs = Math.max(30 * 60_000, ...relevantDevices.map((d) => d.idleThresholdMinutes * 60_000));

    const live = liveView(sessions, now, maxIdleThresholdMs, timeZone);

    return c.json({
      isActive: live.isActive,
      todaySeconds: live.todayWorkedTimeMs / 1000,
      currentSessionSeconds: live.currentSessionMs / 1000,
    });
  });

  app.get("/api/stats/first-activity", async (c) => {
    const deviceId = await resolveDeviceIdFilter(c, deps.devices);
    if (deviceId instanceof Response) return deviceId;

    const firstMs = await deps.events.getFirstEventTimestamp(deviceId);
    return c.json({ date: firstMs === null ? null : isoDateKey(new Date(firstMs)) });
  });

  // ---------- Settings (global, dashboard-display only) ----------

  app.get("/api/settings/", async (c) => {
    const settings = await deps.settings.get();
    return c.json(settings);
  });

  app.put("/api/settings/", async (c) => {
    const body = await c.req
      .json<{ coreHoursStart?: string; coreHoursEnd?: string }>()
      .catch(() => ({ coreHoursStart: undefined, coreHoursEnd: undefined }));
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (!body.coreHoursStart || !timePattern.test(body.coreHoursStart)) {
      return c.json({ error: "coreHoursStart must be HH:mm" }, 400);
    }
    if (!body.coreHoursEnd || !timePattern.test(body.coreHoursEnd)) {
      return c.json({ error: "coreHoursEnd must be HH:mm" }, 400);
    }
    if (body.coreHoursEnd <= body.coreHoursStart) {
      return c.json({ error: "coreHoursEnd must be strictly after coreHoursStart" }, 400);
    }

    const saved = await deps.settings.save({
      coreHoursStart: body.coreHoursStart,
      coreHoursEnd: body.coreHoursEnd,
    });
    return c.json(saved);
  });

  // ---------- Devices (admin UI) ----------

  app.get("/api/devices", async (c) => {
    const devices = await deps.devices.list();
    return c.json(
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        idleThresholdMinutes: d.idleThresholdMinutes,
        pollIntervalSeconds: d.pollIntervalSeconds,
        lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
        revoked: d.revokedAt !== null,
      })),
    );
  });

  app.post("/api/devices", async (c) => {
    const body = await c.req
      .json<{ name?: string; platform?: string }>()
      .catch(() => ({ name: undefined, platform: undefined }));
    const name = body.name?.trim();
    if (!name || name.length > MAX_DEVICE_NAME_LENGTH || (body.platform !== "windows" && body.platform !== "mac")) {
      return c.json(
        { error: `name (1-${MAX_DEVICE_NAME_LENGTH} chars) and platform ('windows' | 'mac') are required` },
        400,
      );
    }

    const rawApiKey = generateApiKey();
    const device = await deps.devices.create({
      name,
      platform: body.platform,
      apiKeyHash: hashApiKey(rawApiKey),
    });

    return c.json({ id: device.id, name: device.name, platform: device.platform, apiKey: rawApiKey });
  });

  // Per-device idle threshold / poll interval — the per-source settings
  // requested for this rewrite; see docs/IMPLEMENTATION_NOTES.md.
  app.patch("/api/devices/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Device not found" }, 404);

    const body = await c.req
      .json<{ idleThresholdMinutes?: number; pollIntervalSeconds?: number }>()
      .catch(() => ({ idleThresholdMinutes: undefined, pollIntervalSeconds: undefined }));

    if (body.idleThresholdMinutes !== undefined && body.idleThresholdMinutes <= 0) {
      return c.json({ error: "idleThresholdMinutes must be > 0" }, 400);
    }
    if (body.pollIntervalSeconds !== undefined && body.pollIntervalSeconds <= 0) {
      return c.json({ error: "pollIntervalSeconds must be > 0" }, 400);
    }

    const updated = await deps.devices.updateSettings(id, body);
    if (!updated) return c.json({ error: "Device not found" }, 404);

    return c.json({
      id: updated.id,
      name: updated.name,
      platform: updated.platform,
      idleThresholdMinutes: updated.idleThresholdMinutes,
      pollIntervalSeconds: updated.pollIntervalSeconds,
    });
  });

  app.delete("/api/devices/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Device not found" }, 404);

    const revoked = await deps.devices.revoke(id, Date.now());
    if (!revoked) return c.json({ error: "Device not found" }, 404);
    return c.body(null, 204);
  });

  // ---------- Event ingestion (trackers) ----------

  app.post("/api/events", async (c) => {
    const authHeader = c.req.header("Authorization");
    const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    if (!rawKey) return c.json({ error: "Missing API key" }, 401);

    const device = await deps.devices.getByApiKeyHash(hashApiKey(rawKey));
    if (!device || device.revokedAt !== null) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }

    const body = await c.req
      .json<{ timestamp?: string; timestamps?: string[] }>()
      .catch(() => ({ timestamp: undefined, timestamps: undefined }));
    const raw = body.timestamps ?? (body.timestamp ? [body.timestamp] : []);

    if (raw.length > MAX_EVENTS_PER_REQUEST) {
      return c.json({ error: `At most ${MAX_EVENTS_PER_REQUEST} timestamps per request` }, 400);
    }

    const parsed = raw.map((t) => Date.parse(t)).filter((ms) => Number.isFinite(ms));

    if (parsed.length === 0) {
      return c.json({ error: "No valid timestamps provided" }, 400);
    }

    await deps.events.insertEvents(device.id, parsed);
    await deps.devices.touchLastSeen(device.id, Date.now());

    return c.body(null, 201);
  });

  // Normalizes any handler failure we didn't already catch (e.g. a
  // repository/DB error) to a generic JSON 500 instead of Hono's default
  // HTML error page, and logs it server-side for diagnosis.
  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

function addOneDay(d: Date): Date {
  return new Date(d.getTime() + 86_400_000);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects malformed device IDs before they reach Postgres, which otherwise throws on invalid uuid syntax. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
