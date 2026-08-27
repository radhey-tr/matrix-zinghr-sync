/**
 * Business-date arithmetic.
 *
 * Dates are handled as YYYY-MM-DD strings in the site's local calendar. UTC is
 * used only as an internal vehicle for day arithmetic, never to shift a value:
 * COSEC's timestamps are local wall clock, and converting them would move
 * attendance across midnight boundaries.
 */

export function todayIso(now: Date = new Date(), timeZone = 'Asia/Kolkata'): string {
  // en-CA renders as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Inclusive span, oldest first. */
export function daysBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) out.push(d);
  return out;
}
