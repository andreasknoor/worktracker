import { describe, expect, it } from "vitest";
import {
  classifySlices,
  mergeClassifiedSessions,
  splitAtInstants,
  trackingModeAt,
  workTypeAt,
  workTypeChangesFromEvents,
} from "../src/classification.js";
import { mergeSessions } from "../src/sessionCalculator.js";
import { splitByDay } from "../src/statistics.js";
import { classifyDay } from "../src/time.js";
import type { TrackingModeChange, WorkSession, WorkTypeChange } from "../src/types.js";

const HOUR = 3_600_000;
const BERLIN = "Europe/Berlin";
// 2026-03-09 is a Monday, 2026-03-14 a Saturday (UTC calendar).
const MON = Date.UTC(2026, 2, 9);
const SAT = Date.UTC(2026, 2, 14);

describe("trackingModeAt", () => {
  const history: TrackingModeChange[] = [
    { effectiveFrom: 100, mode: "auto" },
    { effectiveFrom: 200, mode: "alwaysLeisure" },
    { effectiveFrom: 300, mode: "alwaysWork" },
  ];

  it("falls back to the current mode when there is no history", () => {
    expect(trackingModeAt([], 150, "alwaysWork")).toBe("alwaysWork");
  });

  it("uses the first entry's mode before the first entry", () => {
    expect(trackingModeAt(history, 50, "alwaysWork")).toBe("auto");
  });

  it("switches exactly at effectiveFrom", () => {
    expect(trackingModeAt(history, 199, "auto")).toBe("auto");
    expect(trackingModeAt(history, 200, "auto")).toBe("alwaysLeisure");
    expect(trackingModeAt(history, 10_000, "auto")).toBe("alwaysWork");
  });

  it("lets the later of two entries at the same instant win", () => {
    const tie: TrackingModeChange[] = [
      { effectiveFrom: 100, mode: "alwaysWork" },
      { effectiveFrom: 100, mode: "alwaysLeisure" },
    ];
    expect(trackingModeAt(tie, 100, "auto")).toBe("alwaysLeisure");
  });
});

describe("splitAtInstants", () => {
  it("cuts only at instants strictly inside a slice and keeps extra properties", () => {
    const slices = [{ start: 10, end: 20, date: "d1" }, { start: 30, end: 40, date: "d2" }];
    expect(splitAtInstants(slices, [5, 10, 15, 20, 35, 35, 50])).toEqual([
      { start: 10, end: 15, date: "d1" },
      { start: 15, end: 20, date: "d1" },
      { start: 30, end: 35, date: "d2" },
      { start: 35, end: 40, date: "d2" },
    ]);
  });

  it("leaves slices untouched without instants", () => {
    const slices: WorkSession[] = [{ start: 1, end: 2 }];
    expect(splitAtInstants(slices, [])).toEqual(slices);
  });
});

describe("classifySlices", () => {
  function workTypes(sessions: WorkSession[], history: TrackingModeChange[], fallback: "auto" | "alwaysWork" | "alwaysLeisure" = "auto") {
    return classifySlices(splitByDay(sessions, "UTC"), history, fallback).map(({ start, end, workType }) => ({ start, end, workType }));
  }

  it("without history equals classifyDay with the fallback mode", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 10 * HOUR }, { start: SAT + 9 * HOUR, end: SAT + 10 * HOUR }];
    for (const mode of ["auto", "alwaysWork", "alwaysLeisure"] as const) {
      const expected = splitByDay(sessions, "UTC").map((s) => ({ start: s.start, end: s.end, workType: classifyDay(s.date, mode) }));
      expect(workTypes(sessions, [], mode)).toEqual(expected);
    }
  });

  it("with a single history row equals classifyDay with that row's mode", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: SAT + 10 * HOUR }];
    const expected = splitByDay(sessions, "UTC").map((s) => ({ start: s.start, end: s.end, workType: classifyDay(s.date, "alwaysLeisure") }));
    expect(workTypes(sessions, [{ effectiveFrom: 0, mode: "alwaysLeisure" }], "alwaysWork")).toEqual(expected);
  });

  it("splits a session at a mid-session switch", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 12 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: 0, mode: "auto" },
      { effectiveFrom: MON + 10 * HOUR, mode: "alwaysLeisure" },
    ];
    expect(workTypes(sessions, history)).toEqual([
      { start: MON + 9 * HOUR, end: MON + 10 * HOUR, workType: "work" },
      { start: MON + 10 * HOUR, end: MON + 12 * HOUR, workType: "leisure" },
    ]);
  });

  it("handles several switches on one day, and a switch back", () => {
    const sessions = [{ start: MON + 8 * HOUR, end: MON + 14 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: 0, mode: "auto" },
      { effectiveFrom: MON + 9 * HOUR, mode: "alwaysLeisure" },
      { effectiveFrom: MON + 11 * HOUR, mode: "auto" },
      { effectiveFrom: MON + 13 * HOUR, mode: "alwaysLeisure" },
    ];
    expect(workTypes(sessions, history).map((s) => s.workType)).toEqual(["work", "leisure", "work", "leisure"]);
  });

  it("a switch exactly at midnight coincides with the day boundary", () => {
    // Friday 22:00 to Saturday 02:00 (UTC); alwaysWork from Saturday 00:00.
    const fri = SAT - 24 * HOUR;
    const sessions = [{ start: fri + 22 * HOUR, end: SAT + 2 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: 0, mode: "auto" },
      { effectiveFrom: SAT, mode: "alwaysWork" },
    ];
    expect(workTypes(sessions, history)).toEqual([
      { start: fri + 22 * HOUR, end: SAT, workType: "work" },
      { start: SAT, end: SAT + 2 * HOUR, workType: "work" },
    ]);
  });

  it("classifies activity before the first history row with the first row's mode", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 10 * HOUR }];
    expect(workTypes(sessions, [{ effectiveFrom: MON + 20 * HOUR, mode: "alwaysLeisure" }], "alwaysWork")).toEqual([
      { start: MON + 9 * HOUR, end: MON + 10 * HOUR, workType: "leisure" },
    ]);
  });

  it("accepts an unsorted history", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 12 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: MON + 10 * HOUR, mode: "alwaysLeisure" },
      { effectiveFrom: 0, mode: "auto" },
    ];
    expect(workTypes(sessions, history).map((s) => s.workType)).toEqual(["work", "leisure"]);
  });

  it("keeps the local calendar day on a DST transition day in Europe/Berlin", () => {
    // 2026-03-29 (Sunday) is the spring-forward day; local midnight is 23:00 UTC on the 28th.
    const sundayLocalMidnight = Date.UTC(2026, 2, 28, 23);
    const sessions = [{ start: sundayLocalMidnight - HOUR, end: sundayLocalMidnight + 4 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: 0, mode: "alwaysLeisure" },
      { effectiveFrom: sundayLocalMidnight + 2 * HOUR, mode: "auto" },
    ];
    const result = classifySlices(splitByDay(sessions, BERLIN), history, "auto");
    expect(result.map(({ date, start, end, workType }) => ({ date, start, end, workType }))).toEqual([
      { date: "2026-03-28", start: sundayLocalMidnight - HOUR, end: sundayLocalMidnight, workType: "leisure" },
      { date: "2026-03-29", start: sundayLocalMidnight, end: sundayLocalMidnight + 2 * HOUR, workType: "leisure" },
      // auto on a Sunday is leisure, too
      { date: "2026-03-29", start: sundayLocalMidnight + 2 * HOUR, end: sundayLocalMidnight + 4 * HOUR, workType: "leisure" },
    ]);
  });
});

describe("workTypeChangesFromEvents", () => {
  it("yields nothing for no events", () => {
    expect(workTypeChangesFromEvents([])).toEqual([]);
  });

  it("keeps the first event and the first event of every differing run", () => {
    expect(
      workTypeChangesFromEvents([
        { timestamp: 10, workType: null },
        { timestamp: 20, workType: null },
        { timestamp: 30, workType: "leisure" },
        { timestamp: 40, workType: "leisure" },
        { timestamp: 50, workType: "work" },
        { timestamp: 60, workType: null },
      ]),
    ).toEqual([
      { effectiveFrom: 10, workType: null },
      { effectiveFrom: 30, workType: "leisure" },
      { effectiveFrom: 50, workType: "work" },
      { effectiveFrom: 60, workType: null },
    ]);
  });

  it("sorts unsorted events first", () => {
    expect(
      workTypeChangesFromEvents([
        { timestamp: 30, workType: "work" },
        { timestamp: 10, workType: null },
        { timestamp: 20, workType: null },
      ]),
    ).toEqual([
      { effectiveFrom: 10, workType: null },
      { effectiveFrom: 30, workType: "work" },
    ]);
  });
});

describe("workTypeAt", () => {
  const changes: WorkTypeChange[] = [
    { effectiveFrom: 100, workType: "work" },
    { effectiveFrom: 200, workType: null },
  ];

  it("is null without changes and before the first change", () => {
    expect(workTypeAt([], 150)).toBeNull();
    expect(workTypeAt(changes, 99)).toBeNull();
  });

  it("switches exactly at effectiveFrom", () => {
    expect(workTypeAt(changes, 100)).toBe("work");
    expect(workTypeAt(changes, 199)).toBe("work");
    expect(workTypeAt(changes, 200)).toBeNull();
  });
});

describe("classifySlices with work types stamped by the tracker", () => {
  function workTypes(sessions: WorkSession[], history: TrackingModeChange[], changes: WorkTypeChange[]) {
    return classifySlices(splitByDay(sessions, "UTC"), history, "auto", changes).map(({ start, end, workType }) => ({
      start,
      end,
      workType,
    }));
  }

  it("with only null work types equals the history-based classification", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 12 * HOUR }, { start: SAT + 9 * HOUR, end: SAT + 10 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: 0, mode: "auto" },
      { effectiveFrom: MON + 10 * HOUR, mode: "alwaysLeisure" },
    ];
    const changes: WorkTypeChange[] = [{ effectiveFrom: MON + 9 * HOUR, workType: null }];
    expect(workTypes(sessions, history, changes)).toEqual(workTypes(sessions, history, []));
  });

  it("a stamped work type wins over the device's mode, whatever it is", () => {
    const sessions = [{ start: SAT + 9 * HOUR, end: SAT + 10 * HOUR }, { start: MON + 9 * HOUR, end: MON + 10 * HOUR }];
    expect(
      workTypes(sessions, [{ effectiveFrom: 0, mode: "alwaysLeisure" }], [{ effectiveFrom: 0, workType: "work" }]).map((s) => s.workType),
    ).toEqual(["work", "work"]);
    expect(
      workTypes(sessions, [{ effectiveFrom: 0, mode: "alwaysWork" }], [{ effectiveFrom: 0, workType: "leisure" }]).map((s) => s.workType),
    ).toEqual(["leisure", "leisure"]);
  });

  it("splits a session where the tracker switches, and falls back to the device's mode on null", () => {
    // Monday, device on auto (= work): server, then leisure, then server again.
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 12 * HOUR }];
    const changes: WorkTypeChange[] = [
      { effectiveFrom: MON + 9 * HOUR, workType: null },
      { effectiveFrom: MON + 10 * HOUR, workType: "leisure" },
      { effectiveFrom: MON + 11 * HOUR, workType: null },
    ];
    expect(workTypes(sessions, [{ effectiveFrom: 0, mode: "auto" }], changes)).toEqual([
      { start: MON + 9 * HOUR, end: MON + 10 * HOUR, workType: "work" },
      { start: MON + 10 * HOUR, end: MON + 11 * HOUR, workType: "leisure" },
      { start: MON + 11 * HOUR, end: MON + 12 * HOUR, workType: "work" },
    ]);
  });

  it("cuts at both sources: a device mode change while the tracker is on null", () => {
    const sessions = [{ start: MON + 9 * HOUR, end: MON + 13 * HOUR }];
    const history: TrackingModeChange[] = [
      { effectiveFrom: 0, mode: "auto" },
      { effectiveFrom: MON + 10 * HOUR, mode: "alwaysLeisure" },
    ];
    const changes: WorkTypeChange[] = [
      { effectiveFrom: MON + 9 * HOUR, workType: null },
      { effectiveFrom: MON + 11 * HOUR, workType: "work" },
      { effectiveFrom: MON + 12 * HOUR, workType: null },
    ];
    expect(workTypes(sessions, history, changes).map((s) => s.workType)).toEqual(["work", "leisure", "work", "leisure"]);
  });
});

describe("mergeClassifiedSessions", () => {
  const piece = (deviceId: string, start: number, end: number, workType: "work" | "leisure") => ({ deviceId, start, end, workType });

  it("returns nothing for no pieces", () => {
    expect(mergeClassifiedSessions([])).toEqual([]);
  });

  it("never yields mixed for a single device, even when it switches", () => {
    const result = mergeClassifiedSessions([piece("a", 0, 10, "work"), piece("a", 10, 20, "leisure")]);
    expect(result).toEqual([
      { start: 0, end: 10, workType: "work", deviceIds: ["a"] },
      { start: 10, end: 20, workType: "leisure", deviceIds: ["a"] },
    ]);
  });

  it("marks only the simultaneous part of a work and a leisure device as mixed", () => {
    const result = mergeClassifiedSessions([piece("pc", 0, 20, "work"), piece("mac", 10, 30, "leisure")]);
    expect(result).toEqual([
      { start: 0, end: 10, workType: "work", deviceIds: ["pc"] },
      { start: 10, end: 20, workType: "mixed", deviceIds: ["mac", "pc"] },
      { start: 20, end: 30, workType: "leisure", deviceIds: ["mac"] },
    ]);
  });

  it("does not slice at a device handover within the same type", () => {
    const result = mergeClassifiedSessions([piece("a", 0, 10, "work"), piece("b", 5, 20, "work"), piece("a", 20, 25, "work")]);
    expect(result).toEqual([{ start: 0, end: 25, workType: "work", deviceIds: ["a", "b"] }]);
  });

  it("keeps gaps between sessions", () => {
    const result = mergeClassifiedSessions([piece("a", 0, 10, "work"), piece("a", 15, 20, "work")]);
    expect(result.map(({ start, end }) => [start, end])).toEqual([[0, 10], [15, 20]]);
  });

  it("adds up to the plain merged total (categories are disjoint)", () => {
    const pieces = [
      piece("a", 0, 40, "work"),
      piece("b", 30, 70, "leisure"),
      piece("c", 60, 90, "work"),
      piece("a", 100, 120, "leisure"),
      piece("b", 110, 115, "leisure"),
    ];
    const segmentsTotal = mergeClassifiedSessions(pieces).reduce((sum, s) => sum + (s.end - s.start), 0);
    const mergedTotal = mergeSessions([pieces]).reduce((sum, s) => sum + (s.end - s.start), 0);
    expect(segmentsTotal).toBe(mergedTotal);
  });
});
