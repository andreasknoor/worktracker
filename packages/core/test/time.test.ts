import { describe, expect, it } from "vitest";
import {
  addDays,
  classifyDay,
  dateKeyInZone,
  daysBetween,
  formatHHmm,
  isWeekend,
  minutesSinceMidnight,
  mondayOnOrBefore,
  monthEndExclusive,
  monthStart,
  startOfDayUtcMs,
} from "../src/time.js";

describe("time helpers", () => {
  describe("addDays", () => {
    it("adds positive days within a month", () => {
      expect(addDays("2026-01-05", 3)).toBe("2026-01-08");
    });

    it("adds negative days across a month boundary", () => {
      expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    });

    it("adds days across a year boundary", () => {
      expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    });
  });

  describe("daysBetween", () => {
    it("enumerates an inclusive-start, exclusive-end range", () => {
      expect(daysBetween("2026-01-05", "2026-01-08")).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
    });

    it("returns an empty list for an empty range", () => {
      expect(daysBetween("2026-01-05", "2026-01-05")).toEqual([]);
    });
  });

  describe("monthStart / monthEndExclusive", () => {
    it("returns the first day of the month for any date within it", () => {
      expect(monthStart("2026-02-17")).toBe("2026-02-01");
    });

    it("returns the first day of the next month as the exclusive end", () => {
      expect(monthEndExclusive("2026-02-17")).toBe("2026-03-01");
    });

    it("handles December rolling into the next year", () => {
      expect(monthEndExclusive("2026-12-10")).toBe("2027-01-01");
    });
  });

  describe("mondayOnOrBefore", () => {
    it("returns the same date when it is already a Monday", () => {
      // 2026-01-05 is a Monday.
      expect(mondayOnOrBefore("2026-01-05")).toBe("2026-01-05");
    });

    it("returns the preceding Monday for a mid-week date", () => {
      // 2026-01-08 is a Thursday.
      expect(mondayOnOrBefore("2026-01-08")).toBe("2026-01-05");
    });

    it("returns the preceding Monday for a Sunday", () => {
      // 2026-01-11 is a Sunday.
      expect(mondayOnOrBefore("2026-01-11")).toBe("2026-01-05");
    });
  });

  describe("dateKeyInZone / startOfDayUtcMs", () => {
    it("round-trips a UTC-midnight instant back to the same date key", () => {
      const ms = startOfDayUtcMs("2026-06-15", "UTC");
      expect(dateKeyInZone(ms, "UTC")).toBe("2026-06-15");
    });

    it("shifts the date key across a non-UTC zone boundary", () => {
      // 2026-06-15T00:30:00Z is still 2026-06-14 evening in America/New_York (UTC-4 in June).
      const ms = Date.UTC(2026, 5, 15, 0, 30, 0);
      expect(dateKeyInZone(ms, "America/New_York")).toBe("2026-06-14");
    });
  });

  describe("isWeekend", () => {
    it("returns false for weekdays", () => {
      // 2026-01-05 .. 2026-01-09 is Mon .. Fri.
      for (const d of ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]) {
        expect(isWeekend(d)).toBe(false);
      }
    });

    it("returns true for Saturday and Sunday", () => {
      expect(isWeekend("2026-01-10")).toBe(true); // Saturday
      expect(isWeekend("2026-01-11")).toBe(true); // Sunday
    });
  });

  describe("classifyDay", () => {
    it("auto: classifies a weekday as work", () => {
      expect(classifyDay("2026-01-05", "auto")).toBe("work"); // Monday
    });

    it("auto: classifies a weekend day as leisure", () => {
      expect(classifyDay("2026-01-10", "auto")).toBe("leisure"); // Saturday
    });

    it("alwaysWork: classifies a weekend day as work too", () => {
      expect(classifyDay("2026-01-10", "alwaysWork")).toBe("work"); // Saturday
    });

    it("alwaysLeisure: classifies a weekday as leisure too", () => {
      expect(classifyDay("2026-01-05", "alwaysLeisure")).toBe("leisure"); // Monday
    });
  });

  describe("minutesSinceMidnight / formatHHmm", () => {
    it("computes minutes since local midnight", () => {
      const ms = Date.UTC(2026, 5, 15, 9, 30, 0);
      expect(minutesSinceMidnight(ms, "UTC")).toBe(570);
    });

    it("formats an epoch instant as local HH:mm", () => {
      const ms = Date.UTC(2026, 5, 15, 9, 30, 0);
      expect(formatHHmm(ms, "UTC")).toBe("09:30");
    });
  });
});
