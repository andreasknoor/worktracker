/** Epoch milliseconds (UTC). All domain logic operates on this representation. */
export type Timestamp = number;

export interface WorkSession {
  start: Timestamp;
  end: Timestamp;
}
