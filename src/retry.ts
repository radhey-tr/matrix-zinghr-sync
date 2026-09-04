/**
 * Failure classification, backoff, and the scope rules from §6-§7 of the design.
 *
 * Two rules carry most of the correctness here:
 *
 *  1. Only a rejection naming a specific record advances that record's attempt
 *     count. Outages are not a property of the payload — counting them would
 *     march a day of good swipes into 'abandoned' during someone else's
 *     incident, with logs blaming the data.
 *
 *  2. A failure before the request was sent is safe to retry; a failure while
 *     awaiting a response is not, because the write may already have landed.
 *     Conflating the two is how a design creates duplicates it never needed to.
 */

export type FailureKind =
  /** Never reached the server. Free to retry — no duplicate risk. */
  | 'connect'
  /** Server answered and declined. No duplicate risk. */
  | 'transient'
  /** Request sent, outcome unknown. Retry timidly; see §7. */
  | 'ambiguous'
  /** Token rejected. One forced re-auth, then stop. */
  | 'auth'
  /** Rate limited. Honour Retry-After. */
  | 'rate_limited'
  /** Same request will fail identically. Do not retry. */
  | 'permanent';

export type FailureScope = 'run' | 'day' | 'batch' | 'record';

export interface Classification {
  kind: FailureKind;
  scope: FailureScope;
  retryable: boolean;
  /** Whether this failure is the record's own fault. Gates attempt counting. */
  blamesRecord: boolean;
  retryAfterMs?: number;
  detail: string;
}

/** undici codes that mean the request never left us. */
const CONNECT_PHASE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/**
 * Codes meaning the request was written but no usable response came back.
 * The write may or may not have been applied — that is the whole problem.
 */
const RESPONSE_PHASE_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

function codeOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'UNKNOWN';
  const e = err as { code?: unknown; cause?: { code?: unknown }; name?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (e.cause && typeof e.cause.code === 'string') return e.cause.code;
  if (typeof e.name === 'string') return e.name;
  return 'UNKNOWN';
}

/**
 * Classify a thrown network error.
 *
 * `requestSent` lets the caller narrow the ambiguous case: if we know the
 * request body was never written, even a socket error is safe to retry.
 */
export function classifyNetworkError(err: unknown, requestSent = true): Classification {
  const code = codeOf(err);
  const detail = `${code}: ${err instanceof Error ? err.message : String(err)}`;

  if (CONNECT_PHASE_CODES.has(code)) {
    return { kind: 'connect', scope: 'batch', retryable: true, blamesRecord: false, detail };
  }

  if (RESPONSE_PHASE_CODES.has(code)) {
    if (!requestSent) {
      return { kind: 'connect', scope: 'batch', retryable: true, blamesRecord: false, detail };
    }
    return { kind: 'ambiguous', scope: 'batch', retryable: true, blamesRecord: false, detail };
  }

  // Unrecognised failures are treated as ambiguous rather than transient.
  // Assuming a request did nothing is the assumption that creates duplicates.
  return { kind: 'ambiguous', scope: 'batch', retryable: true, blamesRecord: false, detail };
}

/** Classify an HTTP response we actually received and could read. */
export function classifyHttpStatus(status: number, retryAfterHeader?: string): Classification {
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      scope: 'batch',
      retryable: true,
      blamesRecord: false,
      detail: `HTTP ${status}`,
    };
  }

  if (status === 429) {
    const secs = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const base = {
      kind: 'rate_limited' as const,
      scope: 'batch' as const,
      retryable: true,
      blamesRecord: false,
      detail: `HTTP 429`,
    };
    return Number.isFinite(secs) ? { ...base, retryAfterMs: secs * 1000 } : base;
  }

  if (status >= 500) {
    // The server answered, so we know it did not process the batch.
    return {
      kind: 'transient',
      scope: 'batch',
      retryable: true,
      blamesRecord: false,
      detail: `HTTP ${status}`,
    };
  }

  if (status >= 400) {
    return {
      kind: 'permanent',
      scope: 'record',
      retryable: false,
      blamesRecord: true,
      detail: `HTTP ${status}`,
    };
  }

  return {
    kind: 'transient',
    scope: 'batch',
    retryable: false,
    blamesRecord: false,
    detail: `HTTP ${status}`,
  };
}

/**
 * Exponential backoff with full jitter: random(0, min(cap, base * 2^n)).
 *
 * Full jitter rather than fixed delay matters once a batch of records fails
 * against the same outage — without it they retry in lockstep and recreate the
 * thundering herd on every cycle.
 */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rng = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(rng() * ceiling);
}

/*
 * NOTE: the retry LADDER itself lives in src/run/publish.ts, not here.
 *
 * It is deliberately inline there: every exhausted ladder ends in a specific
 * ledger write (releaseAmbiguous vs releaseUnblamed) and a decision about
 * whether the run continues. Splitting the policy from its consequence put the
 * same rules in two files that could drift, with only the unused copy tested --
 * so the generic runner that used to sit here was removed. This module now
 * classifies failures; publish.ts decides what to do about them.
 */
