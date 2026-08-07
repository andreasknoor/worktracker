import { describe, expect, it } from "vitest";
import { dailyHours, dailySegments, liveView, summary } from "../src/statistics.js";
import type { WorkSession } from "../src/types.js";

// Ported 1:1 from reference-tests/StatisticsServiceTests.cs. Test names mirror
// the original [Fact] method names for traceability. Durations are compared
// in milliseconds instead of TimeSpan.

const HOUR = 60 * 60 * 1000;
const UTC = "UTC";
const UTC_PLUS_ONE = "Etc/GMT-1"; // fixed UTC+1, no DST (mirrors the C# tests' custom UTC+1 zone)

describe("StatisticsServiceTests / dailyHours", () => {
  it("GetDailyHours_WithNoSessions_ReturnsZeroForEveryDayInRange", () => {
    const daily = dailyHours([], "2026-03-10", "2026-03-13", UTC);

    expect(daily).toHaveLength(3);
    expect(daily.every((d) => d.workedTimeMs === 0)).toBe(true);
    expect(daily[0]!.date).toBe("2026-03-10");
    expect(daily[2]!.date).toBe("2026-03-12");
  });

  it("GetDailyHours_SessionEntirelyWithinOneDay_AttributesAllTimeToThatDay", () => {
    const session: WorkSession = { start: Date.UTC(2026, 2, 11, 9, 0, 0), end: Date.UTC(2026, 2, 11, 17, 0, 0) };

    const daily = dailyHours([session], "2026-03-10", "2026-03-13", UTC);

    const day11 = daily.find((d) => d.date === "2026-03-11")!;
    expect(day11.workedTimeMs).toBe(8 * HOUR);
  });

  it("GetDailyHours_SessionSpanningMidnight_SplitsTimeAcrossBothDays", () => {
    // 22:00 on the 11th to 02:00 on the 12th: 2h on day 11, 2h on day 12.
    const session: WorkSession = { start: Date.UTC(2026, 2, 11, 22, 0, 0), end: Date.UTC(2026, 2, 12, 2, 0, 0) };

    const daily = dailyHours([session], "2026-03-10", "2026-03-13", UTC);

    expect(daily.find((d) => d.date === "2026-03-11")!.workedTimeMs).toBe(2 * HOUR);
    expect(daily.find((d) => d.date === "2026-03-12")!.workedTimeMs).toBe(2 * HOUR);
  });

  it("GetDailyHours_SessionSpanningMultipleFullDays_SplitsAcrossEachDay", () => {
    // 10:00 on the 10th to 10:00 on the 13th = 3 full days of activity.
    const session: WorkSession = { start: Date.UTC(2026, 2, 10, 10, 0, 0), end: Date.UTC(2026, 2, 13, 10, 0, 0) };

    const daily = dailyHours([session], "2026-03-10", "2026-03-14", UTC);

    expect(daily.find((d) => d.date === "2026-03-10")!.workedTimeMs).toBe(14 * HOUR);
    expect(daily.find((d) => d.date === "2026-03-11")!.workedTimeMs).toBe(24 * HOUR);
    expect(daily.find((d) => d.date === "2026-03-12")!.workedTimeMs).toBe(24 * HOUR);
    expect(daily.find((d) => d.date === "2026-03-13")!.workedTimeMs).toBe(10 * HOUR);
  });

  it("GetDailyHours_SessionOutsideRequestedRange_IsIgnored", () => {
    const session: WorkSession = { start: Date.UTC(2026, 0, 1, 9, 0, 0), end: Date.UTC(2026, 0, 1, 17, 0, 0) };

    const daily = dailyHours([session], "2026-03-10", "2026-03-13", UTC);

    expect(daily.every((d) => d.workedTimeMs === 0)).toBe(true);
  });

  it("GetDailyHours_UsesTheProvidedTimeZoneForDayBoundaries", () => {
    // 23:30 UTC on the 11th is 00:30 local on the 12th in a UTC+1 zone, so all
    // time should land on the 12th when computed in that zone.
    const session: WorkSession = { start: Date.UTC(2026, 2, 11, 23, 30, 0), end: Date.UTC(2026, 2, 12, 0, 30, 0) };

    const daily = dailyHours([session], "2026-03-11", "2026-03-13", UTC_PLUS_ONE);

    expect(daily.find((d) => d.date === "2026-03-11")!.workedTimeMs).toBe(0);
    expect(daily.find((d) => d.date === "2026-03-12")!.workedTimeMs).toBe(1 * HOUR);
  });
});

describe("StatisticsServiceTests / dailySegments", () => {
  it("GetDailySegments_WithNoSessions_ReturnsEmptySegmentsForEveryDayInRange", () => {
    const daySegments = dailySegments([], "2026-03-10", "2026-03-13", UTC);

    expect(daySegments).toHaveLength(3);
    expect(daySegments.every((d) => d.segments.length === 0)).toBe(true);
  });

  it("GetDailySegments_SessionEntirelyWithinOneDay_ProducesOneSegmentInMinutesSinceMidnight", () => {
    const session: WorkSession = { start: Date.UTC(2026, 2, 11, 9, 0, 0), end: Date.UTC(2026, 2, 11, 17, 30, 0) };

    const daySegments = dailySegments([session], "2026-03-10", "2026-03-13", UTC);

    const day11 = daySegments.find((d) => d.date === "2026-03-11")!;
    expect(day11.segments).toHaveLength(1);
    expect(day11.segments[0]!.startMinutes).toBe(540); // 9:00
    expect(day11.segments[0]!.endMinutes).toBe(1050); // 17:30
  });

  it("GetDailySegments_MultipleSessionsSameDay_ProduceSeparateSegmentsWithAGapBetween", () => {
    // Morning session, lunch break, afternoon session.
    const morning: WorkSession = { start: Date.UTC(2026, 2, 11, 9, 0, 0), end: Date.UTC(2026, 2, 11, 12, 0, 0) };
    const afternoon: WorkSession = { start: Date.UTC(2026, 2, 11, 13, 0, 0), end: Date.UTC(2026, 2, 11, 17, 0, 0) };

    const daySegments = dailySegments([morning, afternoon], "2026-03-10", "2026-03-13", UTC);

    const day11 = daySegments.find((d) => d.date === "2026-03-11")!;
    expect(day11.segments).toHaveLength(2);
    expect(day11.segments[0]!.startMinutes).toBe(540); // 9:00
    expect(day11.segments[0]!.endMinutes).toBe(720); // 12:00 — lunch break starts here
    expect(day11.segments[1]!.startMinutes).toBe(780); // 13:00 — lunch break ends here
    expect(day11.segments[1]!.endMinutes).toBe(1020); // 17:00
  });

  it("GetDailySegments_SessionSpanningMidnight_ClipsSegmentsToEachDaysOwn0To1440Range", () => {
    // 22:00 on the 11th to 02:00 on the 12th.
    const session: WorkSession = { start: Date.UTC(2026, 2, 11, 22, 0, 0), end: Date.UTC(2026, 2, 12, 2, 0, 0) };

    const daySegments = dailySegments([session], "2026-03-10", "2026-03-13", UTC);

    const day11 = daySegments.find((d) => d.date === "2026-03-11")!;
    const day12 = daySegments.find((d) => d.date === "2026-03-12")!;

    expect(day11.segments).toHaveLength(1);
    expect(day11.segments[0]!.startMinutes).toBe(1320); // 22:00
    expect(day11.segments[0]!.endMinutes).toBe(1440); // midnight, clipped to day 11's range

    expect(day12.segments).toHaveLength(1);
    expect(day12.segments[0]!.startMinutes).toBe(0); // midnight, clipped to day 12's range
    expect(day12.segments[0]!.endMinutes).toBe(120); // 02:00
  });

  it("GetDailySegments_SessionOutsideRequestedRange_IsIgnored", () => {
    const session: WorkSession = { start: Date.UTC(2026, 0, 1, 9, 0, 0), end: Date.UTC(2026, 0, 1, 17, 0, 0) };

    const daySegments = dailySegments([session], "2026-03-10", "2026-03-13", UTC);

    expect(daySegments.every((d) => d.segments.length === 0)).toBe(true);
  });
});

describe("StatisticsServiceTests / summary", () => {
  it("GetSummary_WithNoSessions_ReturnsAllZeros", () => {
    const daily = dailyHours([], "2026-03-10", "2026-03-13", UTC);
    const result = summary([], daily);

    expect(result.totalWorkedTimeMs).toBe(0);
    expect(result.activeDayCount).toBe(0);
    expect(result.averageWorkedTimePerActiveDayMs).toBe(0);
    expect(result.longestSessionMs).toBe(0);
  });

  it("GetSummary_ComputesTotalsActiveDaysAverageAndLongestSession", () => {
    const sessions: WorkSession[] = [
      { start: Date.UTC(2026, 2, 10, 9, 0, 0), end: Date.UTC(2026, 2, 10, 13, 0, 0) }, // 4h
      { start: Date.UTC(2026, 2, 11, 9, 0, 0), end: Date.UTC(2026, 2, 11, 17, 0, 0) }, // 8h, longest
    ];

    const daily = dailyHours(sessions, "2026-03-10", "2026-03-13", UTC);
    const result = summary(sessions, daily);

    expect(result.totalWorkedTimeMs).toBe(12 * HOUR);
    expect(result.activeDayCount).toBe(2);
    expect(result.averageWorkedTimePerActiveDayMs).toBe(6 * HOUR);
    expect(result.longestSessionMs).toBe(8 * HOUR);
  });

  it("GetSummary_ActiveDayCount_OnlyCountsDaysWithWorkedTime", () => {
    const session: WorkSession = { start: Date.UTC(2026, 2, 11, 9, 0, 0), end: Date.UTC(2026, 2, 11, 10, 0, 0) };

    // Range spans 3 days, only one has activity.
    const daily = dailyHours([session], "2026-03-10", "2026-03-13", UTC);
    const result = summary([session], daily);

    expect(result.activeDayCount).toBe(1);
    expect(result.averageWorkedTimePerActiveDayMs).toBe(1 * HOUR);
  });
});

describe("StatsEndpointsTests / live (derived from live-related scenarios)", () => {
  const MINUTE = 60 * 1000;
  const SECOND = 1000;
  const idleThreshold = 30 * MINUTE;

  it("GetLive_WithNoActivity_ReturnsInactiveAndZero", () => {
    const result = liveView([], Date.now(), idleThreshold, UTC);

    expect(result.isActive).toBe(false);
    expect(result.todayWorkedTimeMs).toBe(0);
    expect(result.currentSessionMs).toBe(0);
  });

  it("GetLive_WithRecentActivity_ReportsActiveAndExtendsSessionToNow", () => {
    const now = Date.now();
    // A session that started 10 minutes ago and had its last keystroke just
    // now (well within the default 30-min idle threshold) should read as
    // still active; duration is measured from its start to "now".
    const sessions: WorkSession[] = [{ start: now - 10 * MINUTE, end: now - 2 * SECOND }];

    const result = liveView(sessions, now, idleThreshold, UTC);

    expect(result.isActive).toBe(true);
    expect(result.currentSessionMs).toBeGreaterThanOrEqual(595 * SECOND);
    expect(result.currentSessionMs).toBeLessThanOrEqual(610 * SECOND);
    expect(result.todayWorkedTimeMs).toBeGreaterThanOrEqual(result.currentSessionMs);
  });

  it("GetLive_WithOldActivityPastIdleThreshold_ReportsInactiveButKeepsTodayTotal", () => {
    const now = Date.now();
    // Last keystroke 45 minutes ago — past the default 30-min idle threshold
    // — so the session should be closed, not extended to "now".
    const sessions: WorkSession[] = [{ start: now - 60 * MINUTE, end: now - 45 * MINUTE }];

    const result = liveView(sessions, now, idleThreshold, UTC);

    expect(result.isActive).toBe(false);
    expect(result.currentSessionMs).toBe(0);
    expect(result.todayWorkedTimeMs).toBeGreaterThan(0);
  });
});
