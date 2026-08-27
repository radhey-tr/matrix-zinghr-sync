/**
 * Matrix COSEC client.
 *
 * Two things about this endpoint drive the implementation:
 *
 *  1. The query string is SEMICOLON-delimited, not `&`. URLSearchParams would
 *     encode the whole thing as one parameter called `action`, so it is built
 *     by hand. This is not a bug to tidy up later.
 *
 *  2. Nothing about COSEC's column names or date format is compiled in --
 *     production may use a different template. See src/cosec-fields.ts.
 */
import { request } from 'undici';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { StageableSwipe } from './db/repo.ts';
import type { ZingSwipe } from './types.ts';
import {
  compileDateFormat, field, parseDateTime, type CosecFieldMap,
} from './cosec-fields.ts';

export type CosecRow = Record<string, unknown>;

export class CosecError extends Error {}

/** Everything about the source shape, resolved once from config. */
export interface CosecShape {
  responseKey: string;
  fields: CosecFieldMap;
  dateFormat: ReturnType<typeof compileDateFormat>;
}

export function shapeFrom(cfg: Config): CosecShape {
  return {
    responseKey: cfg.COSEC_RESPONSE_KEY,
    fields: {
      emp: cfg.COSEC_FIELD_EMP,
      dateTime: cfg.COSEC_FIELD_DATETIME,
      uniqueId: cfg.COSEC_FIELD_UNIQUE,
      terminal: cfg.COSEC_FIELD_TERMINAL || undefined,
      receivedAt: cfg.COSEC_FIELD_RECEIVED || undefined,
    },
    dateFormat: compileDateFormat(cfg.COSEC_DATETIME_FORMAT),
  };
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

export class CosecClient {
  private readonly cfg: Config;
  private readonly shape: CosecShape;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.shape = shapeFrom(cfg);
  }

  /** Inclusive at both ends, filtered on the swipe timestamp. */
  async fetchRange(fromIso: string, toIso: string): Promise<CosecRow[]> {
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

    return parseRows(text, this.shape.responseKey);
  }
}

export function parseRows(text: string, responseKey: string): CosecRow[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML error page, or a body cut off mid-flight. Staging a partial day
    // and then marking it complete is the one way this design loses data.
    throw new CosecError(`COSEC response was not JSON: ${summarise(text)}`);
  }
  const parsed = z
    .object({ [responseKey]: z.array(z.record(z.unknown())) })
    .safeParse(json);
  if (!parsed.success) {
    // Yielding [] here would mark a day complete having sent nothing.
    throw new CosecError(
      `COSEC response has no "${responseKey}" array: ${summarise(text)}`,
    );
  }
  return parsed.data[responseKey] as CosecRow[];
}

/**
 * COSEC row -> a ledger row ready to stage.
 *
 * Throws for a row we cannot safely represent, so the caller can count and
 * report those rather than letting one malformed record fail an entire day.
 */
export function toStageable(row: CosecRow, shape: CosecShape): StageableSwipe {
  const f = shape.fields;

  const emp = field(row, f.emp);
  if (!emp) throw new CosecError(`employee field "${f.emp}" is empty or absent`);

  const rawDt = field(row, f.dateTime);
  if (!rawDt) throw new CosecError(`timestamp field "${f.dateTime}" is empty or absent`);
  const swipeDateTime = parseDateTime(rawDt, shape.dateFormat);

  const uniqueId = field(row, f.uniqueId);
  if (!uniqueId) {
    throw new CosecError(`identity field "${f.uniqueId}" is empty — no stable dedupe key`);
  }

  const terminalId = field(row, f.terminal) || 'UNKNOWN';

  const payload: ZingSwipe = { empIdentification: emp, swipeDateTime, uniqueId, terminalId };

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
