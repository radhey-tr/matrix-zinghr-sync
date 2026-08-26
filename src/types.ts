/**
 * Domain types shared across the pipeline.
 *
 * The two state machines here mirror §5 of the design doc: a day job answers
 * "has this attendance date been fully delivered?", a swipe record answers
 * "has this individual swipe been delivered?". Recovery reads the second,
 * which is why a retry re-sends a handful of rows rather than a whole day.
 */

export const DAY_STATES = ['pending', 'staged', 'publishing', 'complete', 'stalled'] as const;
export type DayState = (typeof DAY_STATES)[number];

export const SWIPE_STATES = ['pending', 'in_flight', 'sent', 'quarantined', 'abandoned'] as const;
export type SwipeState = (typeof SWIPE_STATES)[number];

/** A swipe exactly as COSEC hands it to us, before any interpretation. */
export interface CosecSwipe {
  empIdentification: string;
  swipeDateTime: string;
  terminalId?: string | undefined;
  swipeReceiveDateTime?: string | undefined;
  uniqueId?: string | undefined;
  swipeLocation?: string | undefined;
  inOutFlag?: string | undefined;
  source?: string | undefined;
}

/**
 * What we actually POST. ZingHR uses only these two fields; everything else in
 * the COSEC payload is reference data we keep locally but do not transmit.
 */
export interface ZingSwipe {
  empIdentification: string;
  swipeDateTime: string;
  /** Optional to ZingHR; sent only for cross-system traceability. */
  uniqueId?: string;
  terminalId?: string;
}

export interface SwipeEventRow {
  id: number;
  attendance_date: string;
  terminal_id: string;
  unique_id: string;
  emp_identification: string;
  swipe_datetime: string;
  payload_json: string;
  state: SwipeState;
  /** Record-scoped failures ONLY. Never incremented by outages — see retry.ts. */
  attempts: number;
  /** Sends whose outcome could not be determined. Tracked apart from attempts. */
  ambiguous_count: number;
  next_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface SyncDayRow {
  attendance_date: string;
  state: DayState;
  fetch_attempts: number;
  last_fetched_at: number | null;
  cosec_count: number | null;
  sent_count: number;
  quarantined_count: number;
  last_error: string | null;
  created_at: number;
  completed_at: number | null;
}

/** Per-record verdict parsed out of a ZingHR sync response. */
export interface RecordOutcome {
  swipeEventId: number;
  accepted: boolean;
  /** Set when accepted is false; drives quarantine vs immediate abandon. */
  permanent?: boolean;
  message?: string;
}
