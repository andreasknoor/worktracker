import { classifyDay, type DateKey } from "./time.js";
import type { Timestamp, TrackingMode, TrackingModeChange, WorkSession, WorkType } from "./types.js";

export type DaySlice = WorkSession & { date: DateKey };
export type ClassifiedSlice = DaySlice & { workType: WorkType };

/**
 * The tracking mode in effect at instant `t`, given a device's history
 * sorted ascending by `effectiveFrom` (for equal instants, the later entry
 * wins). Before the first entry, the first entry's mode applies — the
 * oldest known mode is the best guess for activity that predates it (e.g.
 * small clock skew around device creation). An empty history falls back to
 * `fallback` (the device's current mode).
 */
export function trackingModeAt(
  history: readonly TrackingModeChange[],
  t: Timestamp,
  fallback: TrackingMode,
): TrackingMode {
  if (history.length === 0) return fallback;
  let mode = history[0]!.mode;
  for (const change of history) {
    if (change.effectiveFrom > t) break;
    mode = change.mode;
  }
  return mode;
}

/**
 * Cuts each slice at every instant that falls strictly inside it, keeping
 * all other properties (e.g. `date`) on every piece. Instants on or outside
 * a slice's boundaries leave it untouched.
 */
export function splitAtInstants<T extends WorkSession>(slices: readonly T[], instants: readonly Timestamp[]): T[] {
  const sorted = [...new Set(instants)].sort((a, b) => a - b);
  const result: T[] = [];
  for (const slice of slices) {
    let cursor = slice.start;
    for (const instant of sorted) {
      if (instant <= cursor) continue;
      if (instant >= slice.end) break;
      result.push({ ...slice, start: cursor, end: instant });
      cursor = instant;
    }
    result.push({ ...slice, start: cursor, end: slice.end });
  }
  return result;
}

/**
 * Classifies a device's day-slices (see `splitByDay`) as work or leisure
 * using the tracking mode that was in effect *when the activity happened*:
 * slices are additionally cut at every mode change, and each piece is
 * classified by `classifyDay(date, modeAtPieceStart)`. With an empty
 * history this is exactly `classifyDay(date, fallback)` per slice — the
 * pre-history behavior.
 */
export function classifySlices(
  slices: readonly DaySlice[],
  history: readonly TrackingModeChange[],
  fallback: TrackingMode,
): ClassifiedSlice[] {
  const sortedHistory = [...history].sort((a, b) => a.effectiveFrom - b.effectiveFrom); // stable: ties keep input order
  return splitAtInstants(slices, sortedHistory.map((c) => c.effectiveFrom)).map((piece) => ({
    ...piece,
    workType: classifyDay(piece.date, trackingModeAt(sortedHistory, piece.start, fallback)),
  }));
}
