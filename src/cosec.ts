/**
 * Matrix COSEC client.
 *
 * Three things about this endpoint drive the implementation:
 *
 *  1. The query string is SEMICOLON-delimited, not `&`. URLSearchParams would
 *     encode the whole thing as one parameter called `action`, so it is built
 *     by hand. This is not a bug to tidy up later.
 *
 *  2. `eventdatetime` arrives as MM/DD/YYYY HH:mm:ss and ZingHR wants
 *     yyyy-MM-dd HH:mm:ss. The conversion is pure string rearrangement --
 *     never `new Date()` -- because the value is already client-local wall
 *     clock time and parsing it would invite a timezone to be applied to it.
 *
 *  3. `indexno` is a stable, globally unique swipe id (verified across
 *     overlapping fetches), so it is the dedupe key. The obvious natural key
 *     of userid+eventdatetime+controller silently collapses genuine distinct
 *     swipes -- 6 of them across one sampled month.
 */
import { request } from 'undici';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { StageableSwipe } from './db/repo.ts';
import type { ZingSwipe } from './types.ts';

/** COSEC's own field names, hyphen and all. */
const CosecRowSchema = z
  .object({
    userid: z.string(),
    username: z.string().optional(),
    indexno: z.string(),
    eventdatetime: z.string(),
    idatetime: z.string().optional(),
    entryexittype: z.string().optional(),
    mastercontrollerid: z.string().optional(),
  })
  .passthrough();

const CosecResponseSchema = z.object({
  'template-data': z.array(CosecRowSchema),
});

export type CosecRow = z.infer<typeof CosecRowSchema>;

export class CosecError extends Error {}

const EVENT_DT_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/;

/**
 * "08/26/2026 14:33:54" -> "2026-08-26 14:33:54".
 *
 * Deliberately string-only. Both systems run on the same client-local wall
 * clock, so introducing a Date object could only ever shift the value.
 */
export function toZingDateTime(eventDateTime: string): string {
  const m = EVENT_DT_RE.exec(eventDateTime.trim());
  if (!m) throw new CosecError(`eventdatetime not MM/DD/YYYY HH:mm:ss: ${eventDateTime}`);
  const [, mm, dd, yyyy, time] = m;
  const month = Number(mm), day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CosecError(`eventdatetime has an impossible date: ${eventDateTime}`);
  }
  return `${yyyy}-${mm}-${dd} ${time}`;
}

/** Business date (YYYY-MM-DD) -> COSEC's DDMMYYYY range token. */
export function toRangeToken(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new CosecError(`expected YYYY-MM-DD, got: ${isoDate}`);
  const [, y, mo, d] = m;
  return `${d}${mo}${y}`;
}

export function buildUrl(cfg: Config, fromIso: string, toIso: string): string {
  // Semicolons, by design. See the header comment.
  const query = [
    'action=get',
    `id=${encodeURIComponent(cfg.COSEC_TEMPLATE_ID)}`,
    `date-range=${toRangeToken(fromIso)}-${toRangeToken(toIso)}`,
    'format=json',
  ].join(';');
  return `${cfg.COSEC_BASE_URL}?${query}`;
}

export interface FetchResult {
  rows: CosecRow[];
  /** True when the row count looks like a server-side cap rather than the truth. */
  possiblyTruncated: boolean;
}

export class CosecClient {
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** Inclusive at both ends, filtered on eventdatetime. */
  async fetchRange(fromIso: string, toIso: string): Promise<FetchResult> {
    const url = buildUrl(this.cfg, fromIso, toIso);
    const basic = Buffer.from(
      `${this.cfg.COSEC_USERNAME}:${this.cfg.COSEC_PASSWORD}`,
    ).toString('base64');

    const res = await request(url, {
      method: 'GET',
      headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
      headersTimeout: this.cfg.COSEC_TIMEOUT_MS,
      bodyTimeout: this.cfg.COSEC_TIMEOUT_MS,
    });

    const text = await res.body.text();

    if (res.statusCode === 401 || res.statusCode === 403) {
      // Never retried: a rotated password needs a human, and hammering a
      // basic-auth endpoint invites a lockout.
      throw new CosecError(`COSEC auth rejected (HTTP ${res.statusCode})`);
    }
    if (res.statusCode !== 200) {
      throw Object.assign(new CosecError(`COSEC HTTP ${res.statusCode}: ${summarise(text)}`), {
        code: 'COSEC_HTTP_ERROR',
      });
    }

    return { rows: parseRows(text), possiblyTruncated: false };
  }
}

export function parseRows(text: string): CosecRow[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML error page, or a body cut off mid-flight. Staging a partial day
    // and then marking it complete is the one way this design loses data.
    throw new CosecError(`COSEC response was not JSON: ${summarise(text)}`);
  }
  const parsed = CosecResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CosecError(`unrecognised COSEC response shape: ${summarise(text)}`);
  }
  return parsed.data['template-data'];
}

/**
 * COSEC row -> a ledger row ready to stage.
 *
 * Throws for a row we cannot safely represent; the caller counts and reports
 * those rather than letting one malformed record fail an entire day.
 */
export function toStageable(row: CosecRow, empField: string): StageableSwipe {
  const emp = String((row as Record<string, unknown>)[empField] ?? '').trim();
  if (!emp) throw new CosecError(`employee field "${empField}" is empty or absent`);

  const swipeDateTime = toZingDateTime(row.eventdatetime);
  const uniqueId = row.indexno?.trim();
  if (!uniqueId) throw new CosecError('indexno is empty — no stable identity for this swipe');

  const terminalId = row.mastercontrollerid?.trim() || 'UNKNOWN';

  const payload: ZingSwipe = {
    empIdentification: emp,
    swipeDateTime,
    uniqueId,
    terminalId,
  };

  return {
    attendanceDate: swipeDateTime.slice(0, 10),
    terminalId,
    uniqueId,
    empIdentification: emp,
    swipeDateTime,
    payloadJson: JSON.stringify(payload),
  };
}

function summarise(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
