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
