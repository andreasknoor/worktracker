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
  });

  it("GetLive_WithRecentActivity_ReportsActiveAndExtendsSessionToNow", async () => {
    const now = Date.now();
    // A session that started 10 minutes ago and had its last keystroke just
    // now (well within the default 30-min idle threshold) should read as
    // still active.
    await seedDeviceWithEvents(ctx, [now - 10 * MINUTE, now - 5 * MINUTE, now - 2000]);

    const response = await authedGet(ctx, "/api/stats/live");
    expect(response.status).toBe(200);
    const live = await response.json();

    expect(live.isActive).toBe(true);
    // Session duration is measured from its start to "now", so ~10 minutes.
    expect(live.currentSessionSeconds).toBeGreaterThanOrEqual(595);
    expect(live.currentSessionSeconds).toBeLessThanOrEqual(610);
    expect(live.todaySeconds).toBeGreaterThanOrEqual(live.currentSessionSeconds);
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
});
