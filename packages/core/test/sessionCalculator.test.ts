import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESUME_CONFIRMATION_WINDOW_MS,
  calculateSessions,
  effectiveResumeConfirmationWindow,
  mergeSessions,
} from "../src/sessionCalculator.js";

// Ported 1:1 from reference-tests/SessionCalculatorTests.cs.
// Test names mirror the original [Fact] method names for traceability.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0); // 2026-01-05T09:00:00Z

describe("SessionCalculatorTests", () => {
  it("NoTimestamps_ReturnsNoSessions", () => {
    const sessions = calculateSessions([], 30 * MINUTE);

    expect(sessions).toEqual([]);
  });

  it("SingleTimestamp_ReturnsZeroDurationSession", () => {
    const sessions = calculateSessions([EPOCH], 30 * MINUTE);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start).toBe(EPOCH);
    expect(sessions[0]!.end).toBe(EPOCH);
    expect(sessions[0]!.end - sessions[0]!.start).toBe(0);
  });

  it("GapBelowThreshold_StaysWithinOneSession", () => {
    // 30-minute threshold, 20-minute gap: a normal thinking pause, not idle.
    // No resumption confirmation needed here — that rule only applies to gaps
    // that exceed the idle threshold.
    const timestamps = [EPOCH, EPOCH + 20 * MINUTE, EPOCH + 40 * MINUTE];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start).toBe(EPOCH);
    expect(sessions[0]!.end).toBe(EPOCH + 40 * MINUTE);
  });

  it("GapAboveThreshold_SplitsIntoTwoSessions_WhenResumptionIsConfirmed", () => {
    // 30-minute threshold. No input for 45 minutes should register as idle
    // time, splitting the activity into two sessions with the full 45-minute
    // gap counted as idle (not just the 15 minutes above the threshold). The
    // event after the gap needs a confirming follow-up within the default 60s
    // window to count as a real resumption rather than noise.
    const lastActivityBeforeGap = EPOCH;
    const resumeEvent = EPOCH + 45 * MINUTE;
    const confirmingEvent = resumeEvent + 30 * SECOND;

    const timestamps = [lastActivityBeforeGap, resumeEvent, confirmingEvent];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(2);

    expect(sessions[0]!.start).toBe(lastActivityBeforeGap);
    expect(sessions[0]!.end).toBe(lastActivityBeforeGap);

    expect(sessions[1]!.start).toBe(resumeEvent);
    expect(sessions[1]!.end).toBe(confirmingEvent);

    const idleGap = sessions[1]!.start - sessions[0]!.end;
    expect(idleGap).toBe(45 * MINUTE);
  });

  it("GapExactlyAtThreshold_StaysWithinOneSession", () => {
    // A gap equal to the threshold is not "exceeding" it, so it should not
    // split, and no resumption confirmation is needed.
    const timestamps = [EPOCH, EPOCH + 30 * MINUTE];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(1);
  });

  it("MultipleGapsAboveThreshold_ProduceOneSessionPerActiveSpan", () => {
    const session2Resume = EPOCH + 50 * MINUTE;
    const session2Confirm = session2Resume + 30 * SECOND;
    const session3Resume = session2Confirm + 65 * MINUTE;
    const session3Confirm = session3Resume + 20 * SECOND;

    const timestamps = [
      EPOCH, // session 1
      EPOCH + 10 * MINUTE,
      session2Resume, // 40-min gap from session 1 -> session 2, confirmed below
      session2Confirm,
      session3Resume, // 65-min gap from session 2 -> session 3, confirmed below
      session3Confirm,
    ];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(3);

    expect(sessions[0]!.start).toBe(EPOCH);
    expect(sessions[0]!.end).toBe(EPOCH + 10 * MINUTE);

    expect(sessions[1]!.start).toBe(session2Resume);
    expect(sessions[1]!.end).toBe(session2Confirm);

    expect(sessions[2]!.start).toBe(session3Resume);
    expect(sessions[2]!.end).toBe(session3Confirm);
  });

  it("UnorderedTimestamps_AreSortedBeforeGrouping", () => {
    const timestamps = [EPOCH + 10 * MINUTE, EPOCH, EPOCH + 5 * MINUTE];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start).toBe(EPOCH);
    expect(sessions[0]!.end).toBe(EPOCH + 10 * MINUTE);
  });

  it("TrailingUnconfirmedEvent_IsDroppedAndDoesNotExtendOrCreateASession", () => {
    // The exact scenario reported: an accidental mouse bump after an idle
    // gap, with no further activity following it at all. It must not read as
    // work.
    const timestamps = [EPOCH, EPOCH + 5 * MINUTE, EPOCH + 45 * MINUTE]; // accidental bump, idle gap > threshold, no follow-up

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start).toBe(EPOCH);
    expect(sessions[0]!.end).toBe(EPOCH + 5 * MINUTE);
  });

  it("UnconfirmedBumpFollowedByRealResumption_DoesNotBackdateTheNewSessionStart", () => {
    // The exact regression this rule fixes: an accidental bump lands
    // mid-idle-gap, then real work genuinely resumes later. Without
    // confirmation, the bump would wrongly become the new session's start,
    // backdating it and inflating idle time counted as work. With
    // confirmation, the bump is invisible and the idle gap is measured
    // correctly all the way to the real resumption.
    const priorSessionEnd = EPOCH + 5 * MINUTE;
    const accidentalBump = EPOCH + 45 * MINUTE; // 40-min gap from priorSessionEnd, unconfirmed
    const realResume = accidentalBump + 45 * MINUTE; // 45-min gap from priorSessionEnd, confirmed below
    const realConfirm = realResume + 30 * SECOND;

    const timestamps = [EPOCH, priorSessionEnd, accidentalBump, realResume, realConfirm];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.start).toBe(EPOCH);
    expect(sessions[0]!.end).toBe(priorSessionEnd);

    expect(sessions[1]!.start).toBe(realResume); // not accidentalBump
    expect(sessions[1]!.end).toBe(realConfirm);

    const idleGap = sessions[1]!.start - sessions[0]!.end;
    expect(idleGap).toBe(85 * MINUTE); // includes the invisible bump
  });

  it("MultipleIsolatedBumps_AreAllDroppedUntilAConfirmedResumption", () => {
    const priorSessionEnd = EPOCH;
    const bump1 = EPOCH + 45 * MINUTE;
    const bump2 = EPOCH + 50 * MINUTE; // 5 min after bump1 — not within 60s, so bump1 stays unconfirmed
    const realResume = EPOCH + 80 * MINUTE; // 30 min after bump2 — not within 60s, so bump2 stays unconfirmed
    const realConfirm = realResume + 20 * SECOND;

    const timestamps = [priorSessionEnd, bump1, bump2, realResume, realConfirm];

    const sessions = calculateSessions(timestamps, 30 * MINUTE);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.end).toBe(priorSessionEnd);
    expect(sessions[1]!.start).toBe(realResume);
    expect(sessions[1]!.end).toBe(realConfirm);
  });

  it("CustomConfirmationWindow_WiderThanDefault_ConfirmsAResumptionTheDefaultWouldReject", () => {
    const resumeEvent = EPOCH + 45 * MINUTE;
    const confirmingEvent = resumeEvent + 3 * MINUTE; // 3 minutes later: rejected by the 60s default

    const timestamps = [EPOCH, resumeEvent, confirmingEvent];

    const withDefaultWindow = calculateSessions(timestamps, 30 * MINUTE);
    const withWiderWindow = calculateSessions(timestamps, 30 * MINUTE, 5 * MINUTE);

    expect(withDefaultWindow).toHaveLength(1); // resumption rejected, confirmingEvent dropped too (no further follow-up)
    expect(withWiderWindow).toHaveLength(2); // resumption accepted under the wider window
  });

  it("DefaultResumeConfirmationWindow_Is60Seconds", () => {
    expect(DEFAULT_RESUME_CONFIRMATION_WINDOW_MS).toBe(60 * SECOND);
  });
});

describe("effectiveResumeConfirmationWindow", () => {
  // SESSION_LOGIC_SPEC.md "Default value": if the tracker's configured poll
  // interval is larger than 30 seconds, widen the effective confirmation
  // window to max(60s, 2 x pollInterval) so genuine resumptions aren't
  // wrongly rejected as unconfirmed.

  it("keeps the 60s default when the poll interval is small", () => {
    expect(effectiveResumeConfirmationWindow(15 * SECOND)).toBe(DEFAULT_RESUME_CONFIRMATION_WINDOW_MS);
    expect(effectiveResumeConfirmationWindow(30 * SECOND)).toBe(DEFAULT_RESUME_CONFIRMATION_WINDOW_MS);
  });

  it("widens to 2x the poll interval once that exceeds the 60s default", () => {
    expect(effectiveResumeConfirmationWindow(45 * SECOND)).toBe(90 * SECOND);
    expect(effectiveResumeConfirmationWindow(2 * MINUTE)).toBe(4 * MINUTE);
  });
});

describe("mergeSessions", () => {
  // Each device can have its own idle threshold, so sessions are computed
  // per-device first and merged here — see CONCEPT.md's multi-device note
  // and the mergeSessions doc comment for why raw-timestamp merging no
  // longer applies once idle thresholds are per-device.

  it("returns an empty list when given no devices' sessions", () => {
    expect(mergeSessions([])).toEqual([]);
    expect(mergeSessions([[], []])).toEqual([]);
  });

  it("keeps non-overlapping sessions from different devices separate", () => {
    const deviceA = [{ start: EPOCH, end: EPOCH + 10 * MINUTE }];
    const deviceB = [{ start: EPOCH + 2 * 60 * MINUTE, end: EPOCH + 2 * 60 * MINUTE + 10 * MINUTE }];

    const merged = mergeSessions([deviceA, deviceB]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(deviceA[0]);
    expect(merged[1]).toEqual(deviceB[0]);
  });

  it("merges overlapping activity from two devices into a single session (no double-counting)", () => {
    // Laptop and desktop both active 09:00-10:00, overlapping 09:30-10:30 on
    // the second device. The overlap must not be counted as two sessions'
    // worth of time.
    const deviceA = [{ start: EPOCH + 9 * 60 * MINUTE, end: EPOCH + 10 * 60 * MINUTE }];
    const deviceB = [{ start: EPOCH + 9 * 60 * MINUTE + 30 * MINUTE, end: EPOCH + 10 * 60 * MINUTE + 30 * MINUTE }];

    const merged = mergeSessions([deviceA, deviceB]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBe(deviceA[0]!.start);
    expect(merged[0]!.end).toBe(deviceB[0]!.end);
  });

  it("merges touching (adjacent, zero-gap) sessions across devices", () => {
    const deviceA = [{ start: EPOCH, end: EPOCH + 10 * MINUTE }];
    const deviceB = [{ start: EPOCH + 10 * MINUTE, end: EPOCH + 20 * MINUTE }];

    const merged = mergeSessions([deviceA, deviceB]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBe(EPOCH);
    expect(merged[0]!.end).toBe(EPOCH + 20 * MINUTE);
  });

  it("rejects a non-positive idleThreshold", () => {
    expect(() => calculateSessions([EPOCH, EPOCH + MINUTE], 0)).toThrow(RangeError);
    expect(() => calculateSessions([EPOCH, EPOCH + MINUTE], -MINUTE)).toThrow(RangeError);
  });

  it("rejects a non-positive resumeConfirmationWindow", () => {
    expect(() => calculateSessions([EPOCH, EPOCH + MINUTE], 30 * MINUTE, 0)).toThrow(RangeError);
    expect(() => calculateSessions([EPOCH, EPOCH + MINUTE], 30 * MINUTE, -SECOND)).toThrow(RangeError);
  });
});
