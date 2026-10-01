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
const HOUR = 60 * MINUTE;
const monday = Date.UTC(2026, 2, 9); // a Monday

interface Ctx {
  app: Hono;
  devices: InMemoryDevicesRepository;
  cookie: string;
  clock: { nowMs: number };
}

async function setUp(): Promise<Ctx> {
  const clock = { nowMs: Date.UTC(2026, 2, 1) };
  const now = () => clock.nowMs;
  const devices = new InMemoryDevicesRepository(now);
  const app = createApp({
    devices,
    events: new InMemoryActivityEventsRepository(),
    settings: new InMemorySettingsRepository(),
    now,
  });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  return { app, devices, cookie: login.headers.get("set-cookie")!.split(";")[0]!, clock };
}

async function createDevice(ctx: Ctx, name: string): Promise<{ id: string; apiKey: string }> {
  const response = await ctx.app.request("/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
    body: JSON.stringify({ name, platform: "mac" }),
  });
  return response.json();
}

function asTracker(ctx: Ctx, apiKey: string, path: string, init: RequestInit = {}) {
  return ctx.app.request(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers, Authorization: `Bearer ${apiKey}` },
  });
}

function putMode(ctx: Ctx, apiKey: string, trackingMode: string) {
  return asTracker(ctx, apiKey, "/api/tracker/mode", { method: "PUT", body: JSON.stringify({ trackingMode }) });
}

describe("Tracker self-service: authentication", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setUp();
  });

  it("rejects requests without an API key, on the exact and the sub-path form", async () => {
    for (const [path, method] of [
      ["/api/tracker/mode", "GET"],
      ["/api/tracker/mode", "PUT"],
      ["/api/tracker", "GET"],
    ] as const) {
      const response = await ctx.app.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("does not accept a dashboard session in place of a device key", async () => {
    const response = await ctx.app.request("/api/tracker/mode", { headers: { Cookie: ctx.cookie } });
    expect(response.status).toBe(401);
  });

  it("rejects an unknown or revoked key", async () => {
    expect((await asTracker(ctx, "wtk_live_nope", "/api/tracker/mode")).status).toBe(401);

    const device = await createDevice(ctx, "Laptop");
    await ctx.app.request(`/api/devices/${device.id}`, { method: "DELETE", headers: { Cookie: ctx.cookie } });
    expect((await asTracker(ctx, device.apiKey, "/api/tracker/mode")).status).toBe(401);
    expect((await putMode(ctx, device.apiKey, "alwaysWork")).status).toBe(401);
  });

  it("does not open dashboard routes to a device key", async () => {
    const device = await createDevice(ctx, "Laptop");
    expect((await asTracker(ctx, device.apiKey, "/api/devices")).status).toBe(401);
    expect(
      (await asTracker(ctx, device.apiKey, `/api/devices/${device.id}`, {
        method: "PATCH",
        body: JSON.stringify({ trackingMode: "alwaysWork" }),
      })).status,
    ).toBe(401);
  });
});

describe("Tracker self-service: reading and switching the mode", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setUp();
  });

  it("reads the device's own current mode and since when it applies", async () => {
    const device = await createDevice(ctx, "Laptop");
    const response = await asTracker(ctx, device.apiKey, "/api/tracker/mode");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trackingMode: "auto", effectiveFrom: "2026-03-01T00:00:00.000Z" });
  });

  it("switches only its own device, effective from the time received", async () => {
    const laptop = await createDevice(ctx, "Laptop");
    const desktop = await createDevice(ctx, "Desktop");

    ctx.clock.nowMs = monday + 12 * HOUR;
    const response = await putMode(ctx, laptop.apiKey, "alwaysLeisure");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trackingMode: "alwaysLeisure", effectiveFrom: new Date(monday + 12 * HOUR).toISOString() });

    const list = await (await ctx.app.request("/api/devices", { headers: { Cookie: ctx.cookie } })).json();
    expect(list.find((d: { id: string }) => d.id === laptop.id).trackingMode).toBe("alwaysLeisure");
    expect(list.find((d: { id: string }) => d.id === desktop.id).trackingMode).toBe("auto");
  });

  it("splits classification at the switch", async () => {
    const laptop = await createDevice(ctx, "Laptop");
    ctx.clock.nowMs = monday + 12 * HOUR;
    await putMode(ctx, laptop.apiKey, "alwaysLeisure");

    const timestamps: string[] = [];
    for (let t = monday + 10 * HOUR; t <= monday + 14 * HOUR; t += 10 * MINUTE) timestamps.push(new Date(t).toISOString());
    await asTracker(ctx, laptop.apiKey, "/api/events", { method: "POST", body: JSON.stringify({ timestamps }) });

    const hours = async (workType: string) => {
      const week = await (await ctx.app.request(`/api/stats/week?start=2026-03-09&workType=${workType}`, { headers: { Cookie: ctx.cookie } })).json();
      return week.days[0].hours as number;
    };
    expect(await hours("work")).toBeCloseTo(2, 5);
    expect(await hours("leisure")).toBeCloseTo(2, 5);
  });

  it("is idempotent: re-sending the current mode keeps its original effectiveFrom", async () => {
    const laptop = await createDevice(ctx, "Laptop");
    ctx.clock.nowMs = monday;
    await putMode(ctx, laptop.apiKey, "alwaysWork");
    ctx.clock.nowMs = monday + HOUR;
    const again = await (await putMode(ctx, laptop.apiKey, "alwaysWork")).json();
    expect(again).toEqual({ trackingMode: "alwaysWork", effectiveFrom: new Date(monday).toISOString() });
  });

  it("rejects an unknown mode and a malformed body", async () => {
    const laptop = await createDevice(ctx, "Laptop");
    expect((await putMode(ctx, laptop.apiKey, "sometimes")).status).toBe(400);
    expect((await asTracker(ctx, laptop.apiKey, "/api/tracker/mode", { method: "PUT", body: "{not json" })).status).toBe(400);
    expect((await asTracker(ctx, laptop.apiKey, "/api/tracker/mode", { method: "PUT", body: "{}" })).status).toBe(400);
  });

  it("reports the current mode with every accepted event batch, including dashboard changes", async () => {
    const laptop = await createDevice(ctx, "Laptop");
    const post = () =>
      asTracker(ctx, laptop.apiKey, "/api/events", {
        method: "POST",
        body: JSON.stringify({ timestamps: [new Date(monday).toISOString()] }),
      });

    const first = await post();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ trackingMode: "auto" });

    ctx.clock.nowMs = monday + HOUR;
    await ctx.app.request(`/api/devices/${laptop.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
      body: JSON.stringify({ trackingMode: "alwaysWork" }),
    });
    expect(await (await post()).json()).toEqual({ trackingMode: "alwaysWork" });
  });
});
