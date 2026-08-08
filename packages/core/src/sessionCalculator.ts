import type { Timestamp, WorkSession } from "./types.js";

/** Default resume-confirmation window: 60 seconds. See SESSION_LOGIC_SPEC.md rule 3. */
export const DEFAULT_RESUME_CONFIRMATION_WINDOW_MS = 60_000;

/**
 * Converts a flat list of raw activity timestamps into work sessions.
 *
 * A gap between consecutive timestamps larger than `idleThreshold` ends a
 * session. The event that follows such a gap only starts a new session if a
 * further event confirms it within `resumeConfirmationWindow` — otherwise
 * it's treated as noise (an accidental bump) and dropped without moving the
 * idle-gap measurement anchor. See SESSION_LOGIC_SPEC.md for the full rule set.
 */
export function calculateSessions(
  timestamps: readonly Timestamp[],
  idleThreshold: number,
  resumeConfirmationWindow: number = DEFAULT_RESUME_CONFIRMATION_WINDOW_MS,
): WorkSession[] {
  if (idleThreshold <= 0) {
    throw new RangeError(`idleThreshold must be > 0, got ${idleThreshold}`);
  }
  if (resumeConfirmationWindow <= 0) {
    throw new RangeError(`resumeConfirmationWindow must be > 0, got ${resumeConfirmationWindow}`);
  }

  if (timestamps.length === 0) {
    return [];
  }

  const sorted = [...timestamps].sort((a, b) => a - b);

  const sessions: WorkSession[] = [];
  let currentStart: Timestamp = sorted[0]!;
  let currentEnd: Timestamp = sorted[0]!;

  let i = 1;
  while (i < sorted.length) {
    const current = sorted[i]!;
    const gap = current - currentEnd;

    if (gap <= idleThreshold) {
      currentEnd = current;
      i += 1;
      continue;
    }

    const next = sorted[i + 1];
    const resumptionConfirmed = next !== undefined && next - current <= resumeConfirmationWindow;

    if (resumptionConfirmed) {
      sessions.push({ start: currentStart, end: currentEnd });
      currentStart = current;
      currentEnd = current;
    }
    // else: `current` is an unconfirmed bump — drop it. `currentEnd` is left
    // untouched so the idle gap keeps being measured from the real anchor.

    i += 1;
  }

  sessions.push({ start: currentStart, end: currentEnd });
  return sessions;
}

/**
 * Widens the resume-confirmation window to comfortably fit at least two
 * tracker poll cycles, so a genuine resumption is never wrongly rejected as
 * unconfirmed just because the poll interval is larger than the default
 * window. See SESSION_LOGIC_SPEC.md's "Default value" section.
 */
export function effectiveResumeConfirmationWindow(pollIntervalMs: number): number {
  return Math.max(DEFAULT_RESUME_CONFIRMATION_WINDOW_MS, 2 * pollIntervalMs);
}

/**
 * Merges session lists from multiple devices into one unified list, so that
 * overlapping activity from two devices in the same time window doesn't get
 * double-counted. Unlike single-device sessions, which are derived by
 * `calculateSessions` from raw timestamps, this operates on already-computed
 * session intervals: each device can have its own idle threshold and
 * resume-confirmation window (per-device settings), so there is no single
 * idle threshold that raw multi-device timestamps could be merged under
 * before session calculation. Overlapping or touching (gap <= 0) intervals
 * are unioned; sessions with a genuine idle gap between them stay separate.
 */
export function mergeSessions(sessionLists: readonly (readonly WorkSession[])[]): WorkSession[] {
  const all = sessionLists.flat().slice().sort((a, b) => a.start - b.start);
  if (all.length === 0) {
    return [];
  }

  const merged: WorkSession[] = [];
  let current: WorkSession = { ...all[0]! };

  for (let i = 1; i < all.length; i += 1) {
    const next = all[i]!;
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}
