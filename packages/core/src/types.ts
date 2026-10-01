/** Epoch milliseconds (UTC). All domain logic operates on this representation. */
export type Timestamp = number;

export interface WorkSession {
  start: Timestamp;
  end: Timestamp;
}

/**
 * How a device's logged time is classified into work/leisure. `auto` derives
 * it from the calendar day (see `classifyDay`); `alwaysWork`/`alwaysLeisure`
 * override that per device (e.g. a company PC that should count as work even
 * on a weekend).
 */
export type TrackingMode = "auto" | "alwaysWork" | "alwaysLeisure";

export type WorkType = "work" | "leisure";

/**
 * One row of a device's tracking-mode history: `mode` governs that device's
 * activity from `effectiveFrom` until the next change. Classification is
 * based on the mode in effect at the time the activity happened, not the
 * device's current mode (see `classifySlices`).
 */
export interface TrackingModeChange {
  effectiveFrom: Timestamp;
  mode: TrackingMode;
}
