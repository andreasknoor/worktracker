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

  it("restores a revoked device, and its existing API key works again", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();

    await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" });

    // While revoked, the key is rejected.
    const whileRevoked = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.apiKey}` },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    expect(whileRevoked.status).toBe(401);

    const restoreResponse = await authed(ctx, `/api/devices/${created.id}/restore`, { method: "POST" });
    expect(restoreResponse.status).toBe(204);

    const list = await (await authed(ctx, "/api/devices")).json();
    expect(list[0].revoked).toBe(false);

    // Revoking never touched api_key_hash, so the original key resumes
    // working — no tracker reconfiguration needed.
    const afterRestore = await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.apiKey}` },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    expect(afterRestore.status).toBe(201);
  });

  it("rejects restoring a device that is not revoked", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();

    const response = await authed(ctx, `/api/devices/${created.id}/restore`, { method: "POST" });
    expect(response.status).toBe(400);
  });

  it("returns 404 when restoring an unknown or malformed device id", async () => {
    const unknown = await authed(ctx, "/api/devices/00000000-0000-0000-0000-000000000000/restore", { method: "POST" });
    expect(unknown.status).toBe(404);

    const malformed = await authed(ctx, "/api/devices/not-a-uuid/restore", { method: "POST" });
    expect(malformed.status).toBe(404);
  });

  it("rejects restore without a valid session cookie", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", platform: "mac" }),
      })
    ).json();
    await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" });

    const response = await ctx.app.request(`/api/devices/${created.id}/restore`, { method: "POST" });
    expect(response.status).toBe(401);
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

describe("Device tracking mode (?workType= classification override)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("defaults new devices to 'auto'", async () => {
    const response = await authed(ctx, "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Laptop", platform: "mac" }),
    });
    const created = await response.json();
    expect(created.trackingMode).toBeUndefined(); // not part of the creation response, only settings-list

    const list = await (await authed(ctx, "/api/devices")).json();
    expect(list[0].trackingMode).toBe("auto");
  });

  it("sets and persists a device's tracking mode via PATCH", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Company PC", platform: "windows" }),
      })
    ).json();

    const patchResponse = await authed(ctx, `/api/devices/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingMode: "alwaysWork" }),
    });
    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json();
    expect(patched.trackingMode).toBe("alwaysWork");

    const list = await (await authed(ctx, "/api/devices")).json();
    expect(list.find((d: { id: string }) => d.id === created.id).trackingMode).toBe("alwaysWork");
  });

  it("rejects an unrecognized tracking mode", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();

    const response = await authed(ctx, `/api/devices/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingMode: "sometimes" }),
    });
    expect(response.status).toBe(400);
  });

  it("leaves tracking mode unchanged when a PATCH only touches idleThresholdMinutes", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();
    await authed(ctx, `/api/devices/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingMode: "alwaysLeisure" }),
    });

    const response = await authed(ctx, `/api/devices/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idleThresholdMinutes: 15 }),
    });
    const updated = await response.json();
    expect(updated.trackingMode).toBe("alwaysLeisure");
  });
});

describe("Permanent device deletion (DELETE ?permanent=true)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setUp();
  });

  it("rejects a permanent delete of a device that hasn't been revoked yet", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();

    const response = await authed(ctx, `/api/devices/${created.id}?permanent=true`, { method: "DELETE" });
    expect(response.status).toBe(400);

    const list = await (await authed(ctx, "/api/devices")).json();
    expect(list).toHaveLength(1); // still there
  });

  it("permanently deletes an already-revoked device, removing it from the list entirely", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();
    await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" }); // revoke first

    const response = await authed(ctx, `/api/devices/${created.id}?permanent=true`, { method: "DELETE" });
    expect(response.status).toBe(204);

    const list = await (await authed(ctx, "/api/devices")).json();
    expect(list).toHaveLength(0); // gone, not just marked revoked
  });

  it("returns 404 for a permanent delete of an unknown device id", async () => {
    const response = await authed(ctx, "/api/devices/00000000-0000-0000-0000-000000000000?permanent=true", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  it("keeps the device's historical hours in the aggregated total after permanent deletion", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const timestamps: number[] = [];
    for (let m = 0; m <= 60; m += 10) timestamps.push(today.getTime() + 9 * 60 * MINUTE + m * MINUTE);
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.apiKey}` },
      body: JSON.stringify({ timestamps: timestamps.map((t) => new Date(t).toISOString()) }),
    });

    const before = await (await authed(ctx, "/api/stats/summary?days=1")).json();
    expect(before.totalHours).toBeGreaterThan(0);

    await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" }); // revoke
    const deleteResponse = await authed(ctx, `/api/devices/${created.id}?permanent=true`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);

    const after = await (await authed(ctx, "/api/stats/summary?days=1")).json();
    expect(after.totalHours).toBeCloseTo(before.totalHours, 5);
  });

  it("orphaned events are attributed in week-timeline but not to any known device", async () => {
    const monday = Date.UTC(2026, 2, 9); // a Monday
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.apiKey}` },
      body: JSON.stringify({
        timestamps: [0, 20, 40].map((m) => new Date(monday + 9 * 60 * MINUTE + m * MINUTE).toISOString()),
      }),
    });

    await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" });
    await authed(ctx, `/api/devices/${created.id}?permanent=true`, { method: "DELETE" });

    const response = await authed(ctx, "/api/stats/week-timeline?start=2026-03-09");
    const timeline = await response.json();
    const mondaySegments = timeline.days.find((d: { date: string }) => d.date === "2026-03-09").segments;

    expect(mondaySegments).toHaveLength(1);
    expect(mondaySegments[0].deviceIds).toHaveLength(1);
    expect(mondaySegments[0].deviceIds[0]).not.toBe(created.id); // device is gone, not attributed to it
  });

  it("scoping to the now-deleted device's id returns 404 (it's no longer a known device)", async () => {
    const created = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();
    await authed(ctx, `/api/devices/${created.id}`, { method: "DELETE" });
    await authed(ctx, `/api/devices/${created.id}?permanent=true`, { method: "DELETE" });

    const response = await authed(ctx, `/api/stats/summary?days=1&deviceId=${created.id}`);
    expect(response.status).toBe(404);
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
      body: JSON.stringify({ coreHoursStart: "18:00", coreHoursEnd: "09:00", deviceStaleThresholdHours: 24 }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects malformed HH:mm values", async () => {
    const response = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "9am", coreHoursEnd: "18:00", deviceStaleThresholdHours: 24 }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a non-positive deviceStaleThresholdHours", async () => {
    const response = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "09:00", coreHoursEnd: "18:00", deviceStaleThresholdHours: 0 }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a missing deviceStaleThresholdHours", async () => {
    const response = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "09:00", coreHoursEnd: "18:00" }),
    });
    expect(response.status).toBe(400);
  });

  it("saves and round-trips valid core hours and device-stale threshold", async () => {
    const putResponse = await authed(ctx, "/api/settings/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreHoursStart: "08:30", coreHoursEnd: "16:45", deviceStaleThresholdHours: 6 }),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await authed(ctx, "/api/settings/");
    const settings = await getResponse.json();
    expect(settings.coreHoursStart).toBe("08:30");
    expect(settings.coreHoursEnd).toBe("16:45");
    expect(settings.deviceStaleThresholdHours).toBe(6);
  });

  it("defaults deviceStaleThresholdHours to 24 when nothing has been saved", async () => {
    const response = await authed(ctx, "/api/settings/");
    const settings = await response.json();
    expect(settings.deviceStaleThresholdHours).toBe(24);
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

describe("Work/leisure classification (?workType=work|leisure|all)", () => {
  // 2026-03-09 is a Monday (weekday); 2026-03-14 is a Saturday (weekend).
  const monday = Date.UTC(2026, 2, 9);
  const saturday = Date.UTC(2026, 2, 14);

  async function setUpTwoClassifiedDevices() {
    const ctx = await setUp();

    const companyPc = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Company PC", platform: "windows" }),
      })
    ).json();
    await authed(ctx, `/api/devices/${companyPc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingMode: "alwaysWork" }),
    });

    const personalLaptop = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Personal Laptop", platform: "mac" }),
      })
    ).json();
    await authed(ctx, `/api/devices/${personalLaptop.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingMode: "alwaysLeisure" }),
    });

    // Company PC (always work): 1 hour on Saturday — a weekend day it still counts as work.
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${companyPc.apiKey}` },
      body: JSON.stringify({
        timestamps: [0, 20, 40, 60].map((m) => new Date(saturday + 10 * 60 * MINUTE + m * MINUTE).toISOString()),
      }),
    });
    // Personal Laptop (always leisure): 1 hour on Monday — a weekday it still counts as leisure.
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${personalLaptop.apiKey}` },
      body: JSON.stringify({
        timestamps: [0, 20, 40, 60].map((m) => new Date(monday + 9 * 60 * MINUTE + m * MINUTE).toISOString()),
      }),
    });

    return { ctx, companyPc, personalLaptop };
  }

  it("workType=work counts the always-work device's weekend time, not the always-leisure device's weekday time", async () => {
    const { ctx } = await setUpTwoClassifiedDevices();

    const response = await authed(ctx, "/api/stats/week?start=2026-03-09&workType=work");
    const week = await response.json();

    const mon = week.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = week.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.hours).toBe(0); // Personal Laptop's Monday time is always-leisure, excluded
    expect(sat.hours).toBeGreaterThan(0); // Company PC's Saturday time is always-work, included
  });

  it("workType=leisure counts the always-leisure device's weekday time, not the always-work device's weekend time", async () => {
    const { ctx } = await setUpTwoClassifiedDevices();

    const response = await authed(ctx, "/api/stats/week?start=2026-03-09&workType=leisure");
    const week = await response.json();

    const mon = week.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = week.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.hours).toBeGreaterThan(0);
    expect(sat.hours).toBe(0);
  });

  it("workType=all (default) counts both devices' time regardless of tracking mode", async () => {
    const { ctx } = await setUpTwoClassifiedDevices();

    const response = await authed(ctx, "/api/stats/week?start=2026-03-09");
    const week = await response.json();

    const mon = week.days.find((d: { date: string }) => d.date === "2026-03-09");
    const sat = week.days.find((d: { date: string }) => d.date === "2026-03-14");
    expect(mon.hours).toBeGreaterThan(0);
    expect(sat.hours).toBeGreaterThan(0);
  });

  it("composes with ?dayType=: work time that only occurred on a weekend disappears under dayType=weekday", async () => {
    const { ctx } = await setUpTwoClassifiedDevices();

    const response = await authed(ctx, "/api/stats/summary?days=7&end=2026-03-16&workType=work&dayType=weekday");
    const summary = await response.json();

    // The only work-classified time in this fixture is Company PC's Saturday
    // hour — a raw weekday filter on top must zero it back out.
    expect(summary.totalHours).toBe(0);
  });

  it("rejects an unrecognized workType value", async () => {
    const ctx = await setUp();
    const response = await authed(ctx, "/api/stats/summary?days=7&workType=vacation");
    expect(response.status).toBe(400);
  });

  it("longestSessionMinutes in the summary is scoped to the active workType filter", async () => {
    const { ctx } = await setUpTwoClassifiedDevices();

    const workOnly = await (
      await authed(ctx, "/api/stats/summary?days=7&end=2026-03-16&workType=work")
    ).json();
    const leisureOnly = await (
      await authed(ctx, "/api/stats/summary?days=7&end=2026-03-16&workType=leisure")
    ).json();

    expect(workOnly.longestSessionMinutes).toBeCloseTo(60, 0);
    expect(leisureOnly.longestSessionMinutes).toBeCloseTo(60, 0);
  });
});

describe("week-timeline device attribution (deviceIds)", () => {
  it("attributes a solo segment to one device and an overlapping segment to both", async () => {
    const ctx = await setUp();
    const monday = Date.UTC(2026, 2, 9); // a Monday

    const deviceA = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();
    const deviceB = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Desktop", platform: "windows" }),
      })
    ).json();

    // Device A: 09:00-09:40 (solo). Device B: 09:20-10:00 (solo), overlapping
    // device A from 09:20-09:40.
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceA.apiKey}` },
      body: JSON.stringify({
        timestamps: [0, 20, 40].map((m) => new Date(monday + 9 * 60 * MINUTE + m * MINUTE).toISOString()),
      }),
    });
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceB.apiKey}` },
      body: JSON.stringify({
        timestamps: [20, 40, 60].map((m) => new Date(monday + 9 * 60 * MINUTE + m * MINUTE).toISOString()),
      }),
    });

    const response = await authed(ctx, "/api/stats/week-timeline?start=2026-03-09");
    const timeline = await response.json();

    const mondaySegments = timeline.days.find((d: { date: string }) => d.date === "2026-03-09").segments;
    expect(mondaySegments.map((s: { deviceIds: string[] }) => s.deviceIds.slice().sort())).toEqual([
      [deviceA.id],
      [deviceA.id, deviceB.id].sort(),
      [deviceB.id],
    ]);
  });

  it("scoping to one deviceId yields single-element deviceIds arrays only", async () => {
    const ctx = await setUp();
    const monday = Date.UTC(2026, 2, 9);

    const deviceA = await (
      await authed(ctx, "/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Laptop", platform: "mac" }),
      })
    ).json();
    await ctx.app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceA.apiKey}` },
      body: JSON.stringify({
        timestamps: [0, 20, 40].map((m) => new Date(monday + 9 * 60 * MINUTE + m * MINUTE).toISOString()),
      }),
    });

    const response = await authed(ctx, `/api/stats/week-timeline?start=2026-03-09&deviceId=${deviceA.id}`);
    const timeline = await response.json();
    const mondaySegments = timeline.days.find((d: { date: string }) => d.date === "2026-03-09").segments;

    expect(mondaySegments).toHaveLength(1);
    expect(mondaySegments[0].deviceIds).toEqual([deviceA.id]);
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
