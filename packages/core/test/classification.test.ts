import { describe, expect, it } from "vitest";
import { classifySlices, splitAtInstants, trackingModeAt } from "../src/classification.js";
import { splitByDay } from "../src/statistics.js";
import { classifyDay } from "../src/time.js";
import type { TrackingModeChange, WorkSession } from "../src/types.js";

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
