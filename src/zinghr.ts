/**
 * ZingHR client: token generation and swipe sync.
 *
 * Two contract details from the API docs shape everything here:
 *
 *  - Success is `Code: 1` in the JSON body, NOT the HTTP status. A 200 whose
 *    body says Code 0 is a rejection, and treating it as delivery would mark
 *    swipes sent that payroll never received.
 *
 *  - No documented per-element error attribution. Every documented Code 0
 *    message is a batch-level structural complaint with no index, so when a
 *    batch is rejected the offender must be isolated by bisection (see bisect.ts).
 */
import { request } from 'undici';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { ZingSwipe } from './types.ts';

/** Hard server-side cap, documented. Batches must never exceed it. */
export const MAX_SWIPES_PER_CALL = 5000;

const EnvelopeSchema = z.object({
  Message: z.string().optional().default(''),
  // Defensive: some gateways stringify numerics.
  Code: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  Data: z.unknown().optional(),
});

export class ZingAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class ZingProtocolError extends Error {}

export type SyncVerdict =
  | { kind: 'accepted' }
  /** Batch structurally invalid. Same payload will fail identically. */
  | { kind: 'rejected'; messages: string[] }
  /** Over the 5000 cap — split and resend rather than bisect for a culprit. */
  | { kind: 'too_large'; messages: string[] };

function messagesFrom(envelope: { Message: string; Data?: unknown }): string[] {
  const out: string[] = [];
  if (envelope.Message) out.push(envelope.Message);
  const d = envelope.Data;
  if (typeof d === 'string' && d) out.push(d);
  else if (Array.isArray(d)) out.push(...d.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
  else if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      out.push(typeof v === 'string' ? `${k}: ${v}` : `${k}: ${JSON.stringify(v)}`);
    }
  }
  return out.filter(Boolean);
}

const TOO_LARGE = /maximum\s+\d+\s+swipes/i;

export class ZingHrClient {
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Fetch a token. Deliberately NOT cached.
   *
   * The token lives ~2 minutes and issuing a new one invalidates the previous,
   * so cache-and-refresh logic would compare their `exp` against our clock,
   * where a minute of drift is half the budget. One token per POST removes the
   * arithmetic, the skew, and any chance of two live tokens.
   */
  async authenticate(): Promise<string> {
    const url = new URL(this.cfg.ZINGHR_AUTH_URL);
    if (!url.searchParams.has('apiPermission')) {
      url.searchParams.set('apiPermission', this.cfg.ZINGHR_API_PERMISSION);
    }
    const basic = Buffer.from(
      `${this.cfg.ZINGHR_USERNAME}:${this.cfg.ZINGHR_PASSWORD}`,
    ).toString('base64');

    const res = await request(url, {
      method: 'GET',
      headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
      headersTimeout: this.cfg.ZINGHR_HEADERS_TIMEOUT_MS,
      bodyTimeout: this.cfg.ZINGHR_BODY_TIMEOUT_MS,
    });

    const text = await res.body.text();

    if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 400) {
      // Never retried: bad credentials, an expired App Registration, a missing
      // apiPermission, or an un-allowlisted IP. All need a human.
      throw new ZingAuthError(summarise(text), res.statusCode);
    }

    const env = parseEnvelope(text, 'auth');
    if (env.Code !== 1 || typeof env.Data !== 'string' || !env.Data) {
      throw new ZingAuthError(
        messagesFrom(env).join('; ') || `unexpected auth envelope (Code ${env.Code})`,
        res.statusCode,
      );
    }
    return env.Data;
  }

  /**
   * POST one batch. Throws on transport failure (classified upstream) and on
   * auth rejection; returns a verdict for anything the server actually judged.
   */
  async postBatch(swipes: ZingSwipe[], token: string): Promise<SyncVerdict> {
    if (swipes.length === 0) return { kind: 'accepted' };
    if (swipes.length > MAX_SWIPES_PER_CALL) {
      return { kind: 'too_large', messages: [`local guard: ${swipes.length} > ${MAX_SWIPES_PER_CALL}`] };
    }

    const res = await request(this.cfg.ZINGHR_SYNC_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      // Property name is `swipes` (plural), per the API doc — not `swipe`.
      body: JSON.stringify({ swipes }),
      headersTimeout: this.cfg.ZINGHR_HEADERS_TIMEOUT_MS,
      bodyTimeout: this.cfg.ZINGHR_BODY_TIMEOUT_MS,
    });

    const text = await res.body.text();

    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new ZingAuthError(summarise(text), res.statusCode);
    }
    if (res.statusCode >= 500) {
      // Server answered and declined: we know it did not apply the batch.
      throw Object.assign(new Error(`HTTP ${res.statusCode}: ${summarise(text)}`), {
        code: 'ZING_SERVER_ERROR',
        statusCode: res.statusCode,
      });
    }

    return interpretSyncBody(text);
  }
}

/**
 * Turn a sync response body into a verdict.
 *
 * Exported for tests: this is the function standing between "HTTP 200" and
 * "the swipes are in payroll", and it is the single most consequential parse
 * in the system.
 */
export function interpretSyncBody(text: string): SyncVerdict {
  const env = parseEnvelope(text, 'sync');
  if (env.Code === 1) return { kind: 'accepted' };

  const messages = messagesFrom(env);
  if (messages.some((m) => TOO_LARGE.test(m))) return { kind: 'too_large', messages };
  return { kind: 'rejected', messages };
}

function parseEnvelope(text: string, what: string): z.infer<typeof EnvelopeSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML error page from a gateway, or a truncated body. Never guess.
    throw new ZingProtocolError(`${what}: response was not JSON: ${summarise(text)}`);
  }
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new ZingProtocolError(
      `${what}: unrecognised response shape: ${summarise(text)}`,
    );
  }
  return parsed.data;
}

function summarise(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
