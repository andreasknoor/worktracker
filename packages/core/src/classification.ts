import { classifyDay, type DateKey } from "./time.js";
import type { StampedEvent, Timestamp, TrackingMode, TrackingModeChange, WorkSession, WorkType, WorkTypeChange } from "./types.js";

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
 * Compresses a device's events into the points where the work type its
 * tracker stamped on them changes: one at the first event, then one at the
 * first event of every run with a different value. Events need not be
 * sorted. Empty input yields no changes.
 */
export function workTypeChangesFromEvents(events: readonly StampedEvent[]): WorkTypeChange[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const changes: WorkTypeChange[] = [];
  for (const event of sorted) {
    const last = changes[changes.length - 1];
    if (!last || last.workType !== event.workType) {
      changes.push({ effectiveFrom: event.timestamp, workType: event.workType });
    }
  }
  return changes;
}

/**
 * The work type stamped by the tracker at instant `t`, given change points
 * sorted ascending by `effectiveFrom`, or `null` ("as defined on the
 * server") before the first change and without any.
 */
export function workTypeAt(changes: readonly WorkTypeChange[], t: Timestamp): WorkType | null {
  let workType: WorkType | null = null;
  for (const change of changes) {
    if (change.effectiveFrom > t) break;
    workType = change.workType;
  }
  return workType;
}

/**
 * Classifies a device's day-slices (see `splitByDay`) as work or leisure.
 * Two sources decide, both by their value *when the activity happened*:
 *  - the work type the tracker stamped on its events (`workTypeChanges`,
 *    see `workTypeChangesFromEvents`), if it isn't `null`;
 *  - otherwise the device's tracking mode at the time (`history`), via
 *    `classifyDay(date, modeAtPieceStart)`.
 * Slices are cut at every change of either source, and each piece is
 * classified by the values at its start. With an empty history and no work
 * type changes this is exactly `classifyDay(date, fallback)` per slice —
 * the pre-history behavior.
 */
export function classifySlices(
  slices: readonly DaySlice[],
  history: readonly TrackingModeChange[],
  fallback: TrackingMode,
  workTypeChanges: readonly WorkTypeChange[] = [],
): ClassifiedSlice[] {
  const sortedHistory = [...history].sort((a, b) => a.effectiveFrom - b.effectiveFrom); // stable: ties keep input order
  const sortedWorkTypes = [...workTypeChanges].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  const instants = [...sortedHistory, ...sortedWorkTypes].map((c) => c.effectiveFrom);
  return splitAtInstants(slices, instants).map((piece) => ({
    ...piece,
    workType:
      workTypeAt(sortedWorkTypes, piece.start) ?? classifyDay(piece.date, trackingModeAt(sortedHistory, piece.start, fallback)),
  }));
}

/** Whether time counted as work, leisure, or both at once (two devices classified differently). */
export type WorkTypeCategory = WorkType | "mixed";

/** One classified piece of one device's activity (see `classifySlices`). */
export interface DeviceClassifiedPiece extends WorkSession {
  workType: WorkType;
  deviceId: string;
}

/** A merged interval of the all-devices timeline, attributed by work type rather than by device. */
export interface WorkTypeSegment extends WorkSession {
  workType: WorkTypeCategory;
  /** Every device active at some point within the segment, sorted. */
  deviceIds: string[];
}

/**
 * Merges classified pieces across devices into one timeline whose intervals
 * are attributed by work type: `"work"` or `"leisure"` where only that type
 * was active, `"mixed"` where work and leisure overlapped (only possible
 * with two devices active at once — a single device is one type at any
 * instant). Like `mergeSessionsWithDeviceIds`, but sliced only where the
 * active *category* changes, so a device handover within the same category
 * doesn't fragment the timeline. The categories are disjoint, so their
 * total duration equals the plain `mergeSessions` union of all pieces.
 */
export function mergeClassifiedSessions(pieces: readonly DeviceClassifiedPiece[]): WorkTypeSegment[] {
  const valid = pieces.filter((p) => p.end > p.start);
  if (valid.length === 0) return [];

  const boundaries = [...new Set(valid.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  const byStart = [...valid].sort((a, b) => a.start - b.start);

  const result: WorkTypeSegment[] = [];
  let active: DeviceClassifiedPiece[] = [];
  let next = 0;

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const segStart = boundaries[i]!;
    const segEnd = boundaries[i + 1]!;
    active = active.filter((p) => p.end > segStart);
    while (next < byStart.length && byStart[next]!.start <= segStart) active.push(byStart[next++]!);
    if (active.length === 0) continue; // a gap between sessions

    const hasWork = active.some((p) => p.workType === "work");
    const hasLeisure = active.some((p) => p.workType === "leisure");
    const workType: WorkTypeCategory = hasWork && hasLeisure ? "mixed" : hasWork ? "work" : "leisure";
    const deviceIds = active.map((p) => p.deviceId);

    const last = result[result.length - 1];
    if (last && last.end === segStart && last.workType === workType) {
      last.end = segEnd;
      last.deviceIds = [...new Set([...last.deviceIds, ...deviceIds])].sort();
    } else {
      result.push({ start: segStart, end: segEnd, workType, deviceIds: [...new Set(deviceIds)].sort() });
    }
  }

  return result;
}
