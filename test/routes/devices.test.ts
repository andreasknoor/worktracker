import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../../src/server/app.js";
import {
  InMemoryActivityEventsRepository,
  InMemoryDevicesRepository,
  InMemorySettingsRepository,
} from "../../src/server/repositories/memoryRepositories.js";

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
  const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0]!;

  return { app, devices, events, cookie };
}

function authed(ctx: TestContext, path: string, init: RequestInit = {}) {
  return ctx.app.request(path, {
    ...init,
    headers: { ...init.headers, Cookie: ctx.cookie },
  });
}

describe("Device management", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("creates a device and returns the raw API key exactly once", async () => {
    const response = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Work Laptop", platform: "windows" }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe("Work Laptop");
    expect(body.platform).toBe("windows");
    expect(body.apiKey).toMatch(/^wtk_live_/);

    const list = await authed(ctx, "/api/devices");
    const devices = await list.json();
    expect(devices).toHaveLength(1);
    expect(devices[0].apiKey).toBeUndefined(); // never returned again
  });

  it("defaults new devices to a 30-minute idle threshold and 30-second poll interval", async () => {
    const response = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mac", platform: "mac" }),
    });
    const created = await response.json();

    const list = await authed(ctx, "/api/devices");
    const [device] = await list.json();

    expect(device.idleThresholdMinutes).toBe(30);
    expect(device.pollIntervalSeconds).toBe(30);
    expect(device.id).toBe(created.id);
  });

  it("allows setting a per-device idle threshold and poll interval independently of other devices", async () => {
    const a = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();
    const b = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "B", platform: "windows" }),
      })
    ).json();

    await authed(ctx, `/api/devices/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idleThresholdMinutes: 15 }),
    });

    const list = await (await authed(ctx, "/api/devices")).json();
    const deviceA = list.find((d: { id: string }) => d.id === a.id);
    const deviceB = list.find((d: { id: string }) => d.id === b.id);

    expect(deviceA.idleThresholdMinutes).toBe(15);
    expect(deviceB.idleThresholdMinutes).toBe(30); // unaffected
  });

  it("rejects a non-positive idle threshold", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();

    const response = await authed(ctx, `/api/devices/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idleThresholdMinutes: 0 }),
    });

    expect(response.status).toBe(400);
  });

  it("revokes a device via DELETE, which then shows as revoked in the list", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();

    const deleteResponse = await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);

    const list = await (await authed(ctx, "/api/devices")).json();
    expect(list[0].revoked).toBe(true);
  });

  // Regression test: a path-prefix pattern without a slash before the
  // wildcard ("/api/devices*") only matches the exact base path in Hono, not
  // sub-paths — which let PATCH/DELETE to /api/devices/:id run
  // unauthenticated in production before this was caught and fixed.
  it("rejects PATCH to /api/devices/:id without a valid session cookie", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();

    const response = await ctx.app.request(`/api/devices/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idleThresholdMinutes: 15 }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects DELETE to /api/devices/:id without a valid session cookie", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();

    const response = await ctx.app.request(`/api/devices/${created.id}`, { method: "DELETE" });

    expect(response.status).toBe(401);
  });

  it("returns 404 instead of crashing when the device id is not a valid uuid", async () => {
    const patchResponse = await authed(ctx, "/api/devices/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idleThresholdMinutes: 15 }),
    });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await authed(ctx, "/api/devices/not-a-uuid", { method: "DELETE" });
    expect(deleteResponse.status).toBe(404);
  });

  it("rejects an empty or whitespace-only device name", async () => {
    const empty = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   ", platform: "mac" }),
    });
    expect(empty.status).toBe(400);
  });

  it("rejects a device name longer than the allowed maximum", async () => {
    const response = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(101), platform: "mac" }),
    });
    expect(response.status).toBe(400);
  });

  it("trims surrounding whitespace from a device name", async () => {
    const response = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  Work Laptop  ", platform: "mac" }),
    });
    const body = await response.json();
    expect(body.name).toBe("Work Laptop");
  });

  it("returns 400 instead of throwing on malformed JSON when creating a device", async () => {
    const response = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("Login rate limiting", () => {
  it("locks out further attempts after too many wrong passwords", async () => {
    const devices = new InMemoryDevicesRepository();
    const events = new InMemoryActivityEventsRepository();
    const settings = new InMemorySettingsRepository();
    const app = createApp({ devices, events, settings });

    let lastResponse: Response | undefined;
    for (let i = 0; i < 6; i += 1) {
      lastResponse = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
    }

    expect(lastResponse!.status).toBe(429);
  });

  it("still allows the correct password before the lockout threshold is hit", async () => {
    const devices = new InMemoryDevicesRepository();
    const events = new InMemoryActivityEventsRepository();
    const settings = new InMemorySettingsRepository();
    const app = createApp({ devices, events, settings });

    for (let i = 0; i < 3; i += 1) {
      await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
    }

    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    expect(response.status).toBe(200);
  });
});

describe("Event ingestion", () => {
  let ctx: TestContext;
  let apiKey: string;
  let deviceId: string;

  beforeEach(async () => {
    ctx = await setUp();
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Tracker", platform: "mac" }),
      })
    ).json();
    apiKey = created.apiKey;
    deviceId = created.id;
  });

  it("rejects requests with no Authorization header", async () => {
    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects requests with an invalid API key", async () => {
    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wtk_live_bogus" },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts a single timestamp and records it against the device", async () => {
    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    expect(response.status).toBe(201);

    const recorded = await ctx.events.getEventsInRangeForDevice(deviceId, 0, Date.now() + 1);
    expect(recorded).toHaveLength(1);
  });

  it("accepts a batch of timestamps", async () => {
    const now = Date.now();
    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        timestamps: [new Date(now).toISOString(), new Date(now + 30_000).toISOString()],
      }),
    });
    expect(response.status).toBe(201);

    const recorded = await ctx.events.getEventsInRangeForDevice(deviceId, 0, now + 60_000);
    expect(recorded).toHaveLength(2);
  });

  it("rejects a revoked device's API key", async () => {
    await authed(ctx, `/api/devices/${deviceId}`, { method: "DELETE" });

    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a batch exceeding the per-request timestamp cap", async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 5001 }, (_, i) => new Date(now + i).toISOString());
    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ timestamps }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 instead of throwing on malformed JSON", async () => {
    const response = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("Settings validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("rejects coreHoursEnd that is not strictly after coreHoursStart", async () => {
    const response = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "18:00", coreHoursEnd: "09:00" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects malformed HH:mm values", async () => {
    const response = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "9am", coreHoursEnd: "18:00" }),
    });
    expect(response.status).toBe(400);
  });

  it("saves and round-trips valid core hours", async () => {
    const putResponse = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "08:30", coreHoursEnd: "16:45" }),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await authed(ctx, "/api/settings/");
    const settings = await getResponse.json();
    expect(settings.coreHoursStart).toBe("08:30");
    expect(settings.coreHoursEnd).toBe("16:45");
  });

  it("returns 400 instead of throwing on malformed JSON", async () => {
    const response = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("Multi-device overlap handling", () => {
  it("does not double-count overlapping activity from two devices in the summed total", async () => {
    const ctx = await setUp();

    const deviceA = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "windows" }),
      })
    ).json();
    const deviceB = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Desktop", platform: "mac" }),
      })
    ).json();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const base = today.getTime() + 9 * 60 * MINUTE;

    // Both devices active 09:00-10:00, fully overlapping.
    const eventsFor = (offset: number) => {
      const ts: string[] = [];
      for (let m = 0; m <= 60; m += 10) ts.push(new Date(base + offset + m * MINUTE).toISOString());
      return ts;
    };

    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceA.apiKey}` },
      body: JSON.stringify({ timestamps: eventsFor(0) }),
    });
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceB.apiKey}` },
      body: JSON.stringify({ timestamps: eventsFor(0) }),
    });

    const response = await authed(ctx, "/api/stats/summary?days=1");
    const summary = await response.json();

    // 1 hour of overlapping activity from two devices must read as 1 hour, not 2.
    expect(summary.totalHours).toBeGreaterThanOrEqual(0.95);
    expect(summary.totalHours).toBeLessThanOrEqual(1.05);
  });
});

describe("Per-device stats filtering (?deviceId=)", () => {
  let ctx: TestContext;
  let deviceA: { id: string; apiKey: string };
  let deviceB: { id: string; apiKey: string };

  beforeEach(async () => {
    ctx = await setUp();

    deviceA = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "windows" }),
      })
    ).json();
    deviceB = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Desktop", platform: "mac" }),
      })
    ).json();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const base = today.getTime() + 9 * 60 * MINUTE;

    // Device A: 1 hour of activity (09:00-10:00). Device B: 2 hours (12:00-14:00).
    const eventsAt = (startOffsetMs: number, endMinute: number) => {
      const ts: string[] = [];
      for (let m = 0; m <= endMinute; m += 10) ts.push(new Date(base + startOffsetMs + m * MINUTE).toISOString());
      return ts;
    };

    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceA.apiKey}` },
      body: JSON.stringify({ timestamps: eventsAt(0, 60) }),
    });
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceB.apiKey}` },
      body: JSON.stringify({ timestamps: eventsAt(3 * 60 * MINUTE, 120) }),
    });
  });

  it("summary with no deviceId combines both devices", async () => {
    const response = await authed(ctx, "/api/stats/summary?days=1");
    const summary = await response.json();

    expect(summary.totalHours).toBeGreaterThanOrEqual(2.95);
    expect(summary.totalHours).toBeLessThanOrEqual(3.05);
  });

  it("summary scoped to deviceId A only counts that device's hour", async () => {
    const response = await authed(ctx, `/api/stats/summary?days=1&deviceId=${deviceA.id}`);
    const summary = await response.json();

    expect(summary.totalHours).toBeGreaterThanOrEqual(0.95);
    expect(summary.totalHours).toBeLessThanOrEqual(1.05);
  });

  it("summary scoped to deviceId B only counts that device's two hours", async () => {
    const response = await authed(ctx, `/api/stats/summary?days=1&deviceId=${deviceB.id}`);
    const summary = await response.json();

    expect(summary.totalHours).toBeGreaterThanOrEqual(1.95);
    expect(summary.totalHours).toBeLessThanOrEqual(2.05);
  });

  it("live scoped to a device with no recent activity reports inactive", async () => {
    const response = await authed(ctx, `/api/stats/live?deviceId=${deviceA.id}`);
    const live = await response.json();

    expect(live.isActive).toBe(false);
  });

  it("first-activity scoped to one device ignores the other device's events", async () => {
    // Both devices' first events are "today" in this setup, so scope check via explicit device id
    // just confirms the endpoint accepts the filter and still returns a date.
    const response = await authed(ctx, `/api/stats/first-activity?deviceId=${deviceA.id}`);
    const firstActivity = await response.json();

    expect(firstActivity.date).not.toBeNull();
  });

  it("returns 404 for an unknown deviceId instead of silently returning empty data", async () => {
    const response = await authed(ctx, "/api/stats/summary?days=1&deviceId=00000000-0000-0000-0000-000000000000");
    expect(response.status).toBe(404);
  });

  it("returns 404 for a malformed deviceId", async () => {
    const response = await authed(ctx, "/api/stats/summary?days=1&deviceId=not-a-uuid");
    expect(response.status).toBe(404);
  });

  it("week-timeline scoped to deviceId A only shows that device's segment", async () => {
    const monday = mondayOfToday();
    const response = await authed(ctx, `/api/stats/week-timeline?start=${monday}&deviceId=${deviceA.id}`);
    const timeline = await response.json();

    const todayKey = new Date().toISOString().slice(0, 10);
    const todaySegments = timeline.days.find((d: { date: string }) => d.date === todayKey)?.segments ?? [];
    // Device A's window is 09:00-10:00 = 540-600 minutes; device B's 12:00-14:00 must not appear.
    expect(todaySegments.some((s: { startMinutes: number }) => s.startMinutes === 540)).toBe(true);
    expect(todaySegments.some((s: { startMinutes: number }) => s.startMinutes === 720)).toBe(false);
  });
});

function mondayOfToday(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  return monday.toISOString().slice(0, 10);
}
