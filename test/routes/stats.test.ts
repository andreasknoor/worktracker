import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../../src/server/app.js";
import {
  InMemoryActivityEventsRepository,
  InMemoryDevicesRepository,
  InMemorySettingsRepository,
} from "../../src/server/repositories/memoryRepositories.js";
import { hashApiKey } from "../../src/server/auth.js";

// Ported from reference-tests/StatsEndpointsTests.cs. The original spins up a
// real HTTP server per test with a SQLite-backed repository; here the same
// scenarios run against the Hono app in-process with in-memory repositories,
// which is equivalent for these tests' purposes (they exercise route logic,
// not the database).

process.env.DASHBOARD_PASSWORD = "test-password";
process.env.DASHBOARD_SESSION_SECRET = "test-session-secret";
process.env.APP_TIME_ZONE = "UTC";

const MINUTE = 60_000;

interface TestContext {
  app: Hono;
  devices: InMemoryDevicesRepository;
  events: InMemoryActivityEventsRepository;
  cookie: string;
}

async function setUp(): Promise<TestContext> {
  const devices = new InMemoryDevicesRepository();
  const events = new InMemoryActivityEventsRepository();
  const settings = new InMemorySettingsRepository();
  const app = createApp({ devices, events, settings });

  const loginResponse = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const setCookieHeader = loginResponse.headers.get("set-cookie")!;
  const cookie = setCookieHeader.split(";")[0]!;

  return { app, devices, events, cookie };
}

async function seedDeviceWithEvents(ctx: TestContext, timestampsMs: number[]): Promise<void> {
  const device = await ctx.devices.create({ name: "Test Device", platform: "mac", apiKeyHash: hashApiKey("k") });
  await ctx.events.insertEvents(device.id, timestampsMs);
}

function authedGet(ctx: TestContext, path: string) {
  return ctx.app.request(path, { headers: { Cookie: ctx.cookie } });
}

describe("StatsEndpointsTests", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("GetSummary_WithNoActivity_ReturnsAllZeros", async () => {
    const response = await authedGet(ctx, "/api/stats/summary?days=7");
    expect(response.status).toBe(200);

    const summary = await response.json();
    expect(summary.totalHours).toBe(0);
    expect(summary.activeDayCount).toBe(0);
    expect(summary.rangeDayCount).toBe(7);
    expect(summary.daily).toHaveLength(7);
  });

  it("GetSummary_WithOneEightHourSession_ReportsThatDayAsActive", async () => {
    // Emit timestamps 20 minutes apart across an 8-hour span so the idle
    // threshold (default 30 min) never splits this into multiple sessions.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const timestamps: number[] = [];
    for (let minute = 0; minute <= 8 * 60; minute += 20) {
      timestamps.push(today.getTime() + 9 * 60 * MINUTE + minute * MINUTE);
    }
    await seedDeviceWithEvents(ctx, timestamps);

    const response = await authedGet(ctx, "/api/stats/summary?days=1");
    expect(response.status).toBe(200);
    const summary = await response.json();

    expect(summary.activeDayCount).toBe(1);
    expect(summary.totalHours).toBeGreaterThanOrEqual(7.9);
    expect(summary.totalHours).toBeLessThanOrEqual(8.1);
  });

  it("GetWeek_ReturnsSevenDaysStartingOnTheRequestedMonday", async () => {
    const response = await authedGet(ctx, "/api/stats/week?start=2026-03-09"); // a Monday
    expect(response.status).toBe(200);
    const week = await response.json();

    expect(week.weekStart).toBe("2026-03-09");
    expect(week.weekEndExclusive).toBe("2026-03-16");
    expect(week.days).toHaveLength(7);
    expect(week.days[0].date).toBe("2026-03-09");
    expect(week.days[6].date).toBe("2026-03-15");
  });

  it("GetWeekTimeline_ReturnsPerDaySegmentsInMinutesSinceMidnight", async () => {
    const monday = Date.UTC(2026, 2, 9); // a Monday

    // Morning session: continuous events 20 min apart from 9:00 to 12:00.
    const morning: number[] = [];
    for (let minute = 0; minute <= 180; minute += 20) {
      morning.push(monday + 9 * 60 * MINUTE + minute * MINUTE);
    }
    // Lunch break: the resuming event at 13:00 needs a confirming follow-up
    // within 60s, or it's dropped as an accidental-bump false positive.
    const lunchResume = monday + 13 * 60 * MINUTE;
    // Afternoon session: continuous events 20 min apart from 13:00 to 17:00.
    const afternoon: number[] = [];
    for (let minute = 20; minute <= 240; minute += 20) {
      afternoon.push(monday + 13 * 60 * MINUTE + minute * MINUTE);
    }

    await seedDeviceWithEvents(ctx, [...morning, lunchResume, lunchResume + 30_000, ...afternoon]);

    const response = await authedGet(ctx, "/api/stats/week-timeline?start=2026-03-09");
    expect(response.status).toBe(200);
    const timeline = await response.json();

    expect(timeline.weekStart).toBe("2026-03-09");
    expect(timeline.days).toHaveLength(7);

    const mondaySegments = timeline.days.find((d: { date: string }) => d.date === "2026-03-09").segments;
    expect(mondaySegments).toHaveLength(2);
    expect(mondaySegments[0].startMinutes).toBe(540); // 9:00
    expect(mondaySegments[0].endMinutes).toBe(720); // 12:00
    expect(mondaySegments[1].startMinutes).toBe(780); // 13:00
    expect(mondaySegments[1].endMinutes).toBe(1020); // 17:00

    const tuesdaySegments = timeline.days.find((d: { date: string }) => d.date === "2026-03-10").segments;
    expect(tuesdaySegments).toHaveLength(0);
  });

  it("GetMonth_ReturnsAllDaysOfTheRequestedCalendarMonth", async () => {
    const response = await authedGet(ctx, "/api/stats/month?month=2026-02-15"); // February 2026 (28 days)
    expect(response.status).toBe(200);
    const month = await response.json();

    expect(month.monthStart).toBe("2026-02-01");
    expect(month.monthEndExclusive).toBe("2026-03-01");
    expect(month.days).toHaveLength(28);
    expect(month.days[0].date).toBe("2026-02-01");
    expect(month.days[27].date).toBe("2026-02-28");
  });

  it("GetFirstActivity_WithNoEvents_ReturnsNullDate", async () => {
    const response = await authedGet(ctx, "/api/stats/first-activity");
    expect(response.status).toBe(200);
    const firstActivity = await response.json();

    expect(firstActivity.date).toBeNull();
  });

  it("GetFirstActivity_ReturnsTheEarliestRecordedDate", async () => {
    // Noon UTC keeps the date stable regardless of the process's time zone.
    await seedDeviceWithEvents(ctx, [Date.UTC(2025, 10, 3, 12, 0, 0), Date.UTC(2026, 0, 5, 12, 0, 0)]);

    const response = await authedGet(ctx, "/api/stats/first-activity");
    expect(response.status).toBe(200);
    const firstActivity = await response.json();

    expect(firstActivity.date).toBe("2025-11-03");
  });

  it("GetSessions_ReturnsSessionsOrderedMostRecentFirst", async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    // Two well-separated sessions (idle gap far above the 30-min default
    // threshold). The event resuming the second session needs a confirming
    // follow-up within 60s, or it's dropped as an accidental-bump false positive.
    await seedDeviceWithEvents(ctx, [
      todayMs + 9 * 60 * MINUTE,
      todayMs + 9 * 60 * MINUTE + 5 * MINUTE,
      todayMs + 14 * 60 * MINUTE,
      todayMs + 14 * 60 * MINUTE + 30_000,
      todayMs + 14 * 60 * MINUTE + 5 * MINUTE,
    ]);

    const response = await authedGet(ctx, "/api/stats/sessions?days=1");
    expect(response.status).toBe(200);
    const sessions = await response.json();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].start).toBe("14:00");
    expect(sessions[1].start).toBe("09:00");
  });

  it("GetLive_WithNoActivity_ReturnsInactiveAndZero", async () => {
    const response = await authedGet(ctx, "/api/stats/live");
    expect(response.status).toBe(200);
    const live = await response.json();

    expect(live.isActive).toBe(false);
    expect(live.todaySeconds).toBe(0);
    expect(live.currentSessionSeconds).toBe(0);
    expect(live.activeDeviceIds).toEqual([]);
  });

  it("GetLive_WithRecentActivity_ReportsActiveAndExtendsSessionToNow", async () => {
    const now = Date.now();
    // A session that started 10 minutes ago and had its last keystroke just
    // now (well within the default 30-min idle threshold) should read as
    // still active.
    const device = await ctx.devices.create({ name: "Test Device", platform: "mac", apiKeyHash: hashApiKey("k") });
    await ctx.events.insertEvents(device.id, [now - 10 * MINUTE, now - 5 * MINUTE, now - 2000]);

    const response = await authedGet(ctx, "/api/stats/live");
    expect(response.status).toBe(200);
    const live = await response.json();

    expect(live.isActive).toBe(true);
    // Session duration is measured from its start to "now", so ~10 minutes.
    expect(live.currentSessionSeconds).toBeGreaterThanOrEqual(595);
    expect(live.currentSessionSeconds).toBeLessThanOrEqual(610);
    expect(live.todaySeconds).toBeGreaterThanOrEqual(live.currentSessionSeconds);
    expect(live.activeDeviceIds).toEqual([device.id]);
  });

  it("GetLive_WithTwoDevicesActive_ReportsBothInActiveDeviceIds", async () => {
    const now = Date.now();
    const deviceA = await ctx.devices.create({ name: "Device A", platform: "mac", apiKeyHash: hashApiKey("a") });
    const deviceB = await ctx.devices.create({ name: "Device B", platform: "windows", apiKeyHash: hashApiKey("b") });
    await ctx.events.insertEvents(deviceA.id, [now - 10 * MINUTE, now - 2000]);
    await ctx.events.insertEvents(deviceB.id, [now - 8 * MINUTE, now - 1000]);

    const response = await authedGet(ctx, "/api/stats/live");
    expect(response.status).toBe(200);
    const live = await response.json();

    expect(live.isActive).toBe(true);
    expect([...live.activeDeviceIds].sort()).toEqual([deviceA.id, deviceB.id].sort());
  });

  it("GetLive_WithDeviceIdFilter_ReportsOnlyThatDevice", async () => {
    const now = Date.now();
    const deviceA = await ctx.devices.create({ name: "Device A", platform: "mac", apiKeyHash: hashApiKey("a") });
    const deviceB = await ctx.devices.create({ name: "Device B", platform: "windows", apiKeyHash: hashApiKey("b") });
    await ctx.events.insertEvents(deviceA.id, [now - 10 * MINUTE, now - 2000]);
    await ctx.events.insertEvents(deviceB.id, [now - 8 * MINUTE, now - 1000]);

    const response = await authedGet(ctx, "/api/stats/live?deviceId=" + deviceA.id);
    expect(response.status).toBe(200);
    const live = await response.json();

    expect(live.isActive).toBe(true);
    expect(live.activeDeviceIds).toEqual([deviceA.id]);
  });

  it("GetLive_WithOldActivityPastIdleThreshold_ReportsInactiveButKeepsTodayTotal", async () => {
    const now = Date.now();
    // Last keystroke 45 minutes ago — past the default 30-min idle threshold
    // — so the session should be closed, not extended to "now".
    await seedDeviceWithEvents(ctx, [now - 60 * MINUTE, now - 55 * MINUTE, now - 45 * MINUTE]);

    const response = await authedGet(ctx, "/api/stats/live");
    expect(response.status).toBe(200);
    const live = await response.json();

    expect(live.isActive).toBe(false);
    expect(live.currentSessionSeconds).toBe(0);
    expect(live.todaySeconds).toBeGreaterThan(0);
    expect(live.activeDeviceIds).toEqual([]);
  });
});

describe("stats query param validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("rejects a malformed start date on /api/stats/week", async () => {
    const response = await authedGet(ctx, "/api/stats/week?start=not-a-date");
    expect(response.status).toBe(400);
  });

  it("rejects a missing start date on /api/stats/week", async () => {
    const response = await authedGet(ctx, "/api/stats/week");
    expect(response.status).toBe(400);
  });

  it("rejects a calendar-invalid start date on /api/stats/week-timeline", async () => {
    const response = await authedGet(ctx, "/api/stats/week-timeline?start=2026-02-30");
    expect(response.status).toBe(400);
  });

  it("rejects a malformed month on /api/stats/month", async () => {
    const response = await authedGet(ctx, "/api/stats/month?month=2026-13");
    expect(response.status).toBe(400);
  });

  it("rejects a non-numeric days param on /api/stats/summary", async () => {
    const response = await authedGet(ctx, "/api/stats/summary?days=abc");
    expect(response.status).toBe(400);
  });

  it("rejects a negative days param on /api/stats/summary", async () => {
    const response = await authedGet(ctx, "/api/stats/summary?days=-5");
    expect(response.status).toBe(400);
  });

  it("rejects an out-of-bounds days param on /api/stats/sessions", async () => {
    const response = await authedGet(ctx, "/api/stats/sessions?days=999999999");
    expect(response.status).toBe(400);
  });

  it("rejects a malformed end param on /api/stats/summary", async () => {
    const response = await authedGet(ctx, "/api/stats/summary?days=7&end=not-a-date");
    expect(response.status).toBe(400);
  });

  it("rejects an unrecognized dayType value", async () => {
    const response = await authedGet(ctx, "/api/stats/summary?days=7&dayType=holiday");
    expect(response.status).toBe(400);
  });
});

describe("day-type filtering (?dayType=weekday|weekend|all)", () => {
  let ctx: TestContext;

  // 2026-03-09 is a Monday (weekday); 2026-03-14 is a Saturday (weekend).
  const monday = Date.UTC(2026, 2, 9);
  const saturday = Date.UTC(2026, 2, 14);

  beforeEach(async () => {
    ctx = await setUp();
    await seedDeviceWithEvents(ctx, [
      monday + 9 * 60 * MINUTE,
      monday + 9 * 60 * MINUTE + 5 * MINUTE, // 5-min Monday session
      // The event resuming after the multi-day gap needs a confirming
      // follow-up within 60s, or it's dropped as an accidental-bump false
      // positive (see SESSION_LOGIC_SPEC.md rule 3).
      saturday + 10 * 60 * MINUTE,
      saturday + 10 * 60 * MINUTE + 30_000,
      saturday + 10 * 60 * MINUTE + 20 * MINUTE, // 20-min Saturday session
    ]);
  });

  it("week: zeroes out non-matching days but keeps the full 7-day calendar shape", async () => {
    const response = await authedGet(ctx, "/api/stats/week?start=2026-03-09&dayType=weekday");
    expect(response.status).toBe(200);
    const week = await response.json();

    expect(week.days).toHaveLength(7);
    const mon = week.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = week.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.hours).toBeGreaterThan(0);
    expect(sat.hours).toBe(0);
  });

  it("week: dayType=weekend keeps only the Saturday/Sunday hours", async () => {
    const response = await authedGet(ctx, "/api/stats/week?start=2026-03-09&dayType=weekend");
    const week = await response.json();

    const mon = week.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = week.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.hours).toBe(0);
    expect(sat.hours).toBeGreaterThan(0);
  });

  it("week: dayType=all (default) keeps every day", async () => {
    const response = await authedGet(ctx, "/api/stats/week?start=2026-03-09");
    const week = await response.json();

    const mon = week.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = week.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.hours).toBeGreaterThan(0);
    expect(sat.hours).toBeGreaterThan(0);
  });

  it("week-timeline: excludes segments for non-matching days", async () => {
    const response = await authedGet(ctx, "/api/stats/week-timeline?start=2026-03-09&dayType=weekday");
    const timeline = await response.json();

    const mon = timeline.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = timeline.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.segments.length).toBeGreaterThan(0);
    expect(sat.segments).toHaveLength(0);
  });

  it("summary: totals and longest session only reflect matching days", async () => {
    const weekdayOnly = await (
      await authedGet(ctx, "/api/stats/summary?days=7&end=2026-03-16&dayType=weekday")
    ).json();
    const weekendOnly = await (
      await authedGet(ctx, "/api/stats/summary?days=7&end=2026-03-16&dayType=weekend")
    ).json();

    expect(weekdayOnly.activeDayCount).toBe(1);
    expect(weekendOnly.activeDayCount).toBe(1);
    // Monday session is 5 min, Saturday session is 20 min — longest session
    // must be scoped to the filtered day type, not the whole range.
    expect(weekdayOnly.longestSessionMinutes).toBeCloseTo(5, 1);
    expect(weekendOnly.longestSessionMinutes).toBeCloseTo(20, 1);
  });

  it("sessions: excludes rows for non-matching days", async () => {
    // /api/stats/sessions has no `?end=` override (always relative to the
    // real "now"), so this scenario needs its own dynamically-picked
    // weekday/weekend dates within the last 7 days rather than the fixed
    // March 2026 dates used above.
    const sessionsCtx = await setUp();
    const { weekday, weekend } = recentWeekdayAndWeekendDates();
    await seedDeviceWithEvents(sessionsCtx, [
      weekday.getTime() + 9 * 60 * MINUTE,
      weekday.getTime() + 9 * 60 * MINUTE + 5 * MINUTE,
      weekend.getTime() + 10 * 60 * MINUTE,
      weekend.getTime() + 10 * 60 * MINUTE + 30_000,
      weekend.getTime() + 10 * 60 * MINUTE + 20 * MINUTE,
    ]);

    const response = await authedGet(sessionsCtx, "/api/stats/sessions?days=7&dayType=weekend");
    const rows = await response.json();

    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(weekend.toISOString().slice(0, 10));
  });
});

/** Finds a weekday and a weekend date within the last 7 days (today inclusive), in UTC. */
function recentWeekdayAndWeekendDates(): { weekday: Date; weekend: Date } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let weekday: Date | undefined;
  let weekend: Date | undefined;
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const isWeekendDay = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (isWeekendDay && !weekend) weekend = d;
    if (!isWeekendDay && !weekday) weekday = d;
  }
  if (!weekday || !weekend) throw new Error("Could not find both a weekday and a weekend day in the last 7 days");
  return { weekday, weekend };
}

describe("GET /api/version", () => {
  it("is reachable without a session cookie and returns the app version", async () => {
    const devices = new InMemoryDevicesRepository();
    const events = new InMemoryActivityEventsRepository();
    const settings = new InMemorySettingsRepository();
    const app = createApp({ devices, events, settings });

    const response = await app.request("/api/version");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });
});

describe("dashboard auth gate", () => {
  it("rejects stats requests without a valid session cookie", async () => {
    const devices = new InMemoryDevicesRepository();
    const events = new InMemoryActivityEventsRepository();
    const settings = new InMemorySettingsRepository();
    const app = createApp({ devices, events, settings });

    const response = await app.request("/api/stats/summary?days=7");
    expect(response.status).toBe(401);
  });

  it("rejects login with the wrong password", async () => {
    const devices = new InMemoryDevicesRepository();
    const events = new InMemoryActivityEventsRepository();
    const settings = new InMemorySettingsRepository();
    const app = createApp({ devices, events, settings });

    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(response.status).toBe(401);
  });

  it("does not mark the session cookie Secure outside of production (NODE_ENV !== 'production')", async () => {
    const devices = new InMemoryDevicesRepository();
    const events = new InMemoryActivityEventsRepository();
    const settings = new InMemorySettingsRepository();
    const app = createApp({ devices, events, settings });

    expect(process.env.NODE_ENV).not.toBe("production");

    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const setCookieHeader = response.headers.get("set-cookie")!;
    expect(setCookieHeader).not.toMatch(/Secure/i);
  });
});
