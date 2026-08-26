/**
 * COSEC swipe -> ZingHR payload element.
 *
 * Validation here mirrors ZingHR's documented rules exactly, because every
 * documented Code 0 response is a structural complaint we can make unreachable
 * by checking before we send. That matters more than usual: their errors carry
 * no element index, so one bad record costs a full bisection to find.
 *
 * The timestamp is passed through VERBATIM. Both systems use client-local time
 * in the same `yyyy-MM-dd HH:mm:ss` string format, so any parse-and-reformat
 * here is a chance to introduce an hours-off error for no gain.
 */
import type { CosecSwipe, ZingSwipe } from './types.ts';

export const SWIPE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export const MAX_EMP_ID_LEN = 20;
export const MAX_TERMINAL_ID_LEN = 50;

export class TransformError extends Error {}

export function toZingSwipe(s: CosecSwipe): ZingSwipe {
  const emp = s.empIdentification?.trim() ?? '';
  if (!emp) throw new TransformError('EmpIdentification is required');
  if (emp.length > MAX_EMP_ID_LEN) {
    throw new TransformError(`empIdentification exceeds ${MAX_EMP_ID_LEN} chars: ${emp.length}`);
  }
  if (!SWIPE_DATETIME_RE.test(s.swipeDateTime ?? '')) {
    throw new TransformError(
      `SwipeDateTime must be in yyyy-MM-dd HH:mm:ss format: ${s.swipeDateTime}`,
    );
  }

  const out: ZingSwipe = { empIdentification: emp, swipeDateTime: s.swipeDateTime };

  // uniqueId is optional to ZingHR and carries no logic on their side, but it
  // costs nothing and lets a support question about one swipe be traced across
  // all three systems. Deliberately NOT sending swipeReceiveDateTime: it has a
  // format validation that can reject the whole batch, for zero benefit.
  const uid = s.uniqueId?.trim();
  if (uid) out.uniqueId = uid;

  const term = s.terminalId?.trim();
  if (term && term.length <= MAX_TERMINAL_ID_LEN) out.terminalId = term;

  return out;
}

/** The business date a swipe is filed under locally, for day-job bookkeeping. */
export function attendanceDateOf(s: CosecSwipe): string {
  return s.swipeDateTime.slice(0, 10);
}

/**
 * Local event identity. Scoped to the terminal because uniqueId looks like a
 * per-device sequence -- keying on uniqueId alone would silently discard real
 * swipes from other terminals as duplicates.
 *
 * ZingHR documents uniqueId as optional, so COSEC may omit it; the natural key
 * keeps staging idempotent when it does.
 */
export function identityOf(s: CosecSwipe): { terminalId: string; uniqueId: string } {
  const terminalId = s.terminalId?.trim() || 'UNKNOWN';
  const uniqueId = s.uniqueId?.trim() || `nat:${s.empIdentification}:${s.swipeDateTime}`;
  return { terminalId, uniqueId };
}
