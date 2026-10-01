import { describe, expect, it } from "vitest";
import { compareGoldenNumbers, ORPHANED_EVENTS_KEY, type GoldenExport } from "../../scripts/goldenNumbers.js";

const MINUTE = 60_000;
// 2026-03-09 is a Monday, 2026-03-14 a Saturday.
const monday = Date.UTC(2026, 2, 9);
const saturday = Date.UTC(2026, 2, 14);

/** One hour of activity. The 30 s event confirms the resumption after an idle gap (resume-confirmation rule). */
function hourOfActivity(startMs: number): number[] {
  return [0, 0.5, 20, 40, 60].map((m) => startMs + m * MINUTE);
}

function baseExport(): GoldenExport {
  return {
    exportedAt: new Date(Date.UTC(2026, 2, 16)).toISOString(),
    devices: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Company PC",
        platform: "windows",
        idleThresholdMinutes: 30,
        pollIntervalSeconds: 30,
        trackingMode: "alwaysWork",
        createdAt: Date.UTC(2026, 2, 1),
        revokedAt: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Laptop",
        platform: "mac",
        idleThresholdMinutes: 15,
        pollIntervalSeconds: 60,
        trackingMode: "auto",
        createdAt: Date.UTC(2026, 2, 1),
        revokedAt: null,
      },
    ],
    events: {
      "11111111-1111-4111-8111-111111111111": [...hourOfActivity(monday + 9 * 60 * MINUTE), ...hourOfActivity(saturday + 10 * 60 * MINUTE)],
      "22222222-2222-4222-8222-222222222222": [...hourOfActivity(monday + 23 * 60 * MINUTE), ...hourOfActivity(saturday + 9 * 60 * MINUTE)],
      [ORPHANED_EVENTS_KEY]: hourOfActivity(monday + 14 * 60 * MINUTE),
    },
    trackingModeHistory: null,
  };
}

describe("golden-numbers check", () => {
  it("finds no mismatches when the service classifies like v1.21", async () => {
    const result = await compareGoldenNumbers(baseExport(), "Europe/Berlin", Date.UTC(2026, 2, 16));
    expect(result.daysCompared).toBeGreaterThan(0);
    expect(result.mismatches).toEqual([]);
  });

  it("handles an empty export", async () => {
    const data = { ...baseExport(), events: {} };
    const result = await compareGoldenNumbers(data, "Europe/Berlin", Date.UTC(2026, 2, 16));
    expect(result).toEqual({ rangeStart: null, rangeEndExclusive: null, daysCompared: 0, mismatches: [] });
  });

  it("finds no mismatches for the migration's seed (one row per device at created_at)", async () => {
    const data = baseExport();
    data.trackingModeHistory = data.devices.map((d) => ({ deviceId: d.id, trackingMode: d.trackingMode, effectiveFrom: d.createdAt }));
    const result = await compareGoldenNumbers(data, "Europe/Berlin", Date.UTC(2026, 2, 16));
    expect(result.mismatches).toEqual([]);
  });

  it("reports the days a mid-history switch reclassifies", async () => {
    const data = baseExport();
    const pc = data.devices[0]!;
    data.trackingModeHistory = [
      { deviceId: pc.id, trackingMode: "auto", effectiveFrom: pc.createdAt },
      // The Company PC was only switched to alwaysWork after its Saturday hour.
      { deviceId: pc.id, trackingMode: "alwaysWork", effectiveFrom: Date.UTC(2026, 2, 15) },
    ];
    const result = await compareGoldenNumbers(data, "Europe/Berlin", Date.UTC(2026, 2, 16));
    expect(new Set(result.mismatches.map((m) => `${m.workType} ${m.date}`))).toEqual(
      new Set(["work 2026-03-14", "leisure 2026-03-14"]),
    );
  });
});
