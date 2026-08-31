/**
 * Declarative COSEC field mapping.
 *
 * The production Matrix instance may use a different report template, whose
 * column names and date format need not match UAT's. Nothing about those names
 * is compiled into logic: they are configuration, so adapting to a new template
 * is an .env change and a `doctor` run rather than a code change and a release.
 *
 * The date format is configurable for a specific and dangerous reason. If a
 * production template emits DD/MM/YYYY where UAT emits MM/DD/YYYY, a hardcoded
 * parser reads 03/08 as March 8th instead of August 3rd -- attendance shifted by
 * months, with no error anywhere. Making the pattern explicit forces the choice
 * to be stated rather than assumed.
 */

export class DateFormatError extends Error {}

export interface CosecFieldMap {
  /** Column carrying ZingHR's employee code. */
  emp: string;
  /** Column carrying the swipe timestamp. */
  dateTime: string;
  /** Column carrying a stable per-swipe identity. This is the dedupe key. */
  uniqueId: string;
  /** Optional: reader/controller identity, kept for diagnosis. */
  terminal?: string | undefined;
  /** Optional: when COSEC recorded the swipe. Used to report arrival lag. */
  receivedAt?: string | undefined;
  /** Optional: direction as COSEC reports it. */
  inOut?: string | undefined;
}

interface CompiledFormat {
  regex: RegExp;
  /** Which capture group holds each component, 1-indexed. */
  groups: { yyyy: number; MM: number; dd: number; HH: number; mm: number; ss: number };
  pattern: string;
}

const TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'] as const;
type Token = (typeof TOKENS)[number];

const WIDTH: Record<Token, number> = { YYYY: 4, MM: 2, DD: 2, HH: 2, mm: 2, ss: 2 };

/**
 * Turn a pattern like "MM/DD/YYYY HH:mm:ss" into a strict matcher.
 *
 * Strict on purpose: a lenient parser that accepts several shapes is a parser
 * that will one day accept the wrong one silently.
 */
export function compileDateFormat(pattern: string): CompiledFormat {
  let src = '^';
  const order: Token[] = [];
  let i = 0;

  while (i < pattern.length) {
    const token = TOKENS.find((t) => pattern.startsWith(t, i));
    if (token) {
      if (order.includes(token)) throw new DateFormatError(`token ${token} appears twice in "${pattern}"`);
      order.push(token);
      src += `(\\d{${WIDTH[token]}})`;
      i += token.length;
    } else {
      src += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  src += '$';

  for (const required of TOKENS) {
    if (!order.includes(required)) {
      throw new DateFormatError(`pattern "${pattern}" is missing ${required}`);
    }
  }

  const at = (t: Token) => order.indexOf(t) + 1;
  return {
    regex: new RegExp(src),
    groups: { yyyy: at('YYYY'), MM: at('MM'), dd: at('DD'), HH: at('HH'), mm: at('mm'), ss: at('ss') },
    pattern,
  };
}

/**
 * Parse into ZingHR's `yyyy-MM-dd HH:mm:ss`.
 *
 * Pure string rearrangement -- no Date object is ever constructed. The value is
 * already client-local wall clock time, and handing it to a Date would invite a
 * timezone to be applied to something that has none.
 */
export function parseDateTime(value: string, fmt: CompiledFormat): string {
  const m = fmt.regex.exec(value.trim());
  if (!m) throw new DateFormatError(`"${value}" does not match ${fmt.pattern}`);

  const g = (n: number) => m[n]!;
  const yyyy = g(fmt.groups.yyyy);
  const MM = g(fmt.groups.MM);
  const dd = g(fmt.groups.dd);

  const month = Number(MM), day = Number(dd);
  if (month < 1 || month > 12) throw new DateFormatError(`month ${MM} out of range in "${value}"`);
  if (day < 1 || day > 31) throw new DateFormatError(`day ${dd} out of range in "${value}"`);
  const hh = Number(g(fmt.groups.HH));
  if (hh > 23) throw new DateFormatError(`hour ${hh} out of range in "${value}"`);

  return `${yyyy}-${MM}-${dd} ${g(fmt.groups.HH)}:${g(fmt.groups.mm)}:${g(fmt.groups.ss)}`;
}

/** Read a column, tolerating absence, and trim. */
export function field(row: Record<string, unknown>, name: string | undefined): string {
  if (!name) return '';
  const v = row[name];
  return v === undefined || v === null ? '' : String(v).trim();
}
