import { Hono } from "hono";
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
import { appTimeZone } from "./config.js";
import type { ActivityEventsRepository, DevicesRepository, SettingsRepository } from "./repositories/types.js";
import { getMergedSessionsInRange } from "./services/sessionsService.js";

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

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();
  const timeZone = appTimeZone();

  // ---------- Dashboard auth ----------

  app.post("/api/auth/login", async (c) => {
    const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
    if (!body.password || !verifyDashboardPassword(body.password)) {
      return c.json({ error: "Invalid password" }, 401);
    }
    setCookie(c, DASHBOARD_SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.json({ ok: true });
  });

  app.use("/api/stats/*", async (c, next) => {
    if (!verifySessionToken(getCookie(c, DASHBOARD_SESSION_COOKIE))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
  app.use("/api/settings/*", async (c, next) => {
    if (!verifySessionToken(getCookie(c, DASHBOARD_SESSION_COOKIE))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
  app.use("/api/devices*", async (c, next) => {
    if (!verifySessionToken(getCookie(c, DASHBOARD_SESSION_COOKIE))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  // ---------- Stats ----------

  app.get("/api/stats/week", async (c) => {
    const start = c.req.query("start")!;
    const endExclusive = addDays(start, 7);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
    );
    const daily = dailyHours(sessions, start, endExclusive, timeZone);

    return c.json({
      weekStart: start,
      weekEndExclusive: endExclusive,
      days: daily.map((d) => ({ date: d.date, hours: d.workedTimeMs / 3_600_000 })),
    });
  });

  app.get("/api/stats/week-timeline", async (c) => {
    const start = c.req.query("start")!;
    const endExclusive = addDays(start, 7);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
    );
    const segments = dailySegments(sessions, start, endExclusive, timeZone);

    return c.json({
      weekStart: start,
      weekEndExclusive: endExclusive,
      days: segments.map((d) => ({ date: d.date, segments: d.segments })),
    });
  });

  app.get("/api/stats/month", async (c) => {
    const monthAnyDate = c.req.query("month")!;
    const start = monthStart(monthAnyDate);
    const endExclusive = monthEndExclusive(monthAnyDate);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
    );
    const daily = dailyHours(sessions, start, endExclusive, timeZone);

    return c.json({
      monthStart: start,
      monthEndExclusive: endExclusive,
      days: daily.map((d) => ({ date: d.date, hours: d.workedTimeMs / 3_600_000 })),
    });
  });

  app.get("/api/stats/summary", async (c) => {
    const days = Number(c.req.query("days") ?? "7");
    const endParam = c.req.query("end");
    const endExclusive = endParam ?? isoDateKey(addOneDay(new Date()));
    const start = addDays(endExclusive, -days);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
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
    const days = Number(c.req.query("days") ?? "7");
    const endExclusive = isoDateKey(addOneDay(new Date()));
    const start = addDays(endExclusive, -days);

    const sessions = await getMergedSessionsInRange(
      deps.devices,
      deps.events,
      Date.parse(start + "T00:00:00Z"),
      Date.parse(endExclusive + "T00:00:00Z"),
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
    const now = Date.now();
    const todayKey = isoDateKey(new Date(now));
    // Buffer well past any device's idle threshold so the session that's
    // potentially still running is fully captured.
    const bufferedStart = Date.parse(addDays(todayKey, -1) + "T00:00:00Z");

    const sessions = await getMergedSessionsInRange(deps.devices, deps.events, bufferedStart, now + 1);

    const devices = await deps.devices.list();
    const maxIdleThresholdMs = Math.max(30 * 60_000, ...devices.map((d) => d.idleThresholdMinutes * 60_000));

    const live = liveView(sessions, now, maxIdleThresholdMs, timeZone);

    return c.json({
      isActive: live.isActive,
      todaySeconds: live.todayWorkedTimeMs / 1000,
      currentSessionSeconds: live.currentSessionMs / 1000,
    });
  });

  app.get("/api/stats/first-activity", async (c) => {
    const firstMs = await deps.events.getFirstEventTimestamp();
    return c.json({ date: firstMs === null ? null : isoDateKey(new Date(firstMs)) });
  });

  // ---------- Settings (global, dashboard-display only) ----------

  app.get("/api/settings/", async (c) => {
    const settings = await deps.settings.get();
    return c.json(settings);
  });

  app.put("/api/settings/", async (c) => {
    const body = await c.req.json<{ coreHoursStart?: string; coreHoursEnd?: string }>();
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
    const body = await c.req.json<{ name?: string; platform?: string }>();
    if (!body.name || (body.platform !== "windows" && body.platform !== "mac")) {
      return c.json({ error: "name and platform ('windows' | 'mac') are required" }, 400);
    }

    const rawApiKey = generateApiKey();
    const device = await deps.devices.create({
      name: body.name,
      platform: body.platform,
      apiKeyHash: hashApiKey(rawApiKey),
    });

    return c.json({ id: device.id, name: device.name, platform: device.platform, apiKey: rawApiKey });
  });

  // Per-device idle threshold / poll interval — the per-source settings
  // requested for this rewrite; see docs/IMPLEMENTATION_NOTES.md.
  app.patch("/api/devices/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ idleThresholdMinutes?: number; pollIntervalSeconds?: number }>();

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

    const body = await c.req.json<{ timestamp?: string; timestamps?: string[] }>();
    const raw = body.timestamps ?? (body.timestamp ? [body.timestamp] : []);
    const parsed = raw.map((t) => Date.parse(t)).filter((ms) => Number.isFinite(ms));

    if (parsed.length === 0) {
      return c.json({ error: "No valid timestamps provided" }, 400);
    }

    await deps.events.insertEvents(device.id, parsed);
    await deps.devices.touchLastSeen(device.id, Date.now());

    return c.body(null, 201);
  });

  return app;
}

function addOneDay(d: Date): Date {
  return new Date(d.getTime() + 86_400_000);
}
