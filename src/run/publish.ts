/**
 * The publisher: drains pending swipes to ZingHR, strictly serially.
 *
 * Serial is a deliberate choice rather than a constraint. Tokens were expected
 * to revoke one another, which would have forced it; UAT shows they do not.
 * It stays because volume is tiny -- one batch typically covers a week -- so
 * parallelism would buy nothing and cost moving parts.
 *
 * The three outcomes are deliberately handled differently:
 *
 *   accepted   -> mark sent, done.
 *   rejected   -> the server judged the batch and declined. Validation runs
 *                 before any insert, so NOTHING landed -- including the good
 *                 records. Rejections name the offending element
 *                 (`swipes[1].SwipeDateTime`), so those are quarantined and
 *                 the remainder re-sent. Bisection is the fallback for
 *                 batch-scoped complaints that name no index.
 *   ambiguous  -> we do not know whether it applied. Retry once, then defer to
 *                 tomorrow, because every extra attempt can mint a duplicate.
 */
import type { Config } from '../config.ts';
import type { Repo } from '../db/repo.ts';
import type { RecordOutcome, SwipeEventRow, ZingSwipe } from '../types.ts';
import type { SyncVerdict } from '../zinghr.ts';
import { ZingAuthError, ZingProtocolError } from '../zinghr.ts';
import { bisect } from '../bisect.ts';
import { backoffMs, classifyNetworkError, type Classification } from '../retry.ts';

export interface Publisher {
  authenticate(): Promise<string>;
  postBatch(swipes: ZingSwipe[], token: string): Promise<SyncVerdict>;
}

export interface PublishStats {
  batches: number;
  calls: number;
  sent: number;
  rejected: number;
  ambiguous: number;
  /**
   * Slowest single POST this run, and how many rows were in it.
   *
   * This is the number BATCH_SIZE is tuned against. ZingHR validates and
   * inserts the whole array before responding, so duration scales with batch
   * size, and ZINGHR_HEADERS_TIMEOUT_MS is a cliff rather than a slope:
   * crossing it converts a success into an ambiguous send -- the one outcome
   * that can duplicate rows in payroll. Watching this creep toward the timeout
   * is how you find out BEFORE that happens rather than after.
   */
  maxPostMs: number;
  maxPostCount: number;
  /** Set when the run stopped early; days stay incomplete and retry tomorrow. */
  abortedReason?: string;
}

export interface PublishDeps {
  repo: Repo;
  client: Publisher;
  cfg: Config;
  log?: (event: string, detail: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

const noSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function payloadOf(row: SwipeEventRow): ZingSwipe {
  return JSON.parse(row.payload_json) as ZingSwipe;
}

/**
 * Classify anything thrown while sending.
 *
 * A response we cannot parse is treated as ambiguous rather than transient:
 * the server answered, and we have no idea what it did. Assuming a failed
 * request did nothing is precisely the assumption that creates duplicates.
 */
function classifySendError(err: unknown): Classification {
  if (err instanceof ZingAuthError) {
    return { kind: 'auth', scope: 'run', retryable: false, blamesRecord: false, detail: err.message };
  }
  if (err instanceof ZingProtocolError) {
    return { kind: 'ambiguous', scope: 'batch', retryable: true, blamesRecord: false, detail: err.message };
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ZING_SERVER_ERROR') {
    return {
      kind: 'transient',
      scope: 'batch',
      retryable: true,
      blamesRecord: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return classifyNetworkError(err);
}

export async function publish(deps: PublishDeps): Promise<PublishStats> {
  const { repo, client, cfg } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? noSleep;

  const stats: PublishStats = {
    batches: 0, calls: 0, sent: 0, rejected: 0, ambiguous: 0,
    maxPostMs: 0, maxPostCount: 0,
  };

  // One fresh token per POST. The 1200s TTL makes caching viable, but at this
  // volume it would save roughly one call a night and add expiry arithmetic.
  //
  // Auth is deliberately NOT included in the timing below: it is a fixed cost
  // per POST, and folding it in would inflate the one number that BATCH_SIZE
  // is chosen against.
  let lastPostMs = 0;
  const sendOnce = async (swipes: ZingSwipe[]): Promise<SyncVerdict> => {
    stats.calls++;
    const token = await client.authenticate();
    const startedAt = Date.now();
    try {
      // `return await` is load-bearing: without it the finally block runs
      // before the request settles and every measurement reads ~0ms.
      return await client.postBatch(swipes, token);
    } finally {
      lastPostMs = Date.now() - startedAt;
      if (lastPostMs > stats.maxPostMs) {
        stats.maxPostMs = lastPostMs;
        stats.maxPostCount = swipes.length;
      }
    }
  };

  // A deferral returns records to 'pending' so tomorrow can pick them up --
  // which means this run must STOP rather than re-claim them, or the drain
  // loop spins on the same batch forever. Deferrals are systemic anyway
  // (network, gateway, unknown outcome); continuing would only add load.
  let stop: string | undefined;

  while (!stop) {
    const rows = repo.claimBatch(cfg.BATCH_SIZE);
    if (rows.length === 0) break;
    stats.batches++;

    const ids = rows.map((r) => r.id);
    let attempt = 0;
    let ambiguousAttempts = 0;
    let settled = false;

    while (!settled) {
      let verdict: SyncVerdict;
      try {
        verdict = await sendOnce(rows.map(payloadOf));
      } catch (err) {
        const c = classifySendError(err);

        if (c.kind === 'auth') {
          // Every batch needs a token; there is nothing useful to continue
          // with. Records go back untouched and the run ends.
          repo.releaseUnblamed(ids, c.detail, null);
          stats.abortedReason = `auth: ${c.detail}`;
          log('publish.abort', { reason: c.detail });
          return stats;
        }

        if (c.kind === 'ambiguous') {
          ambiguousAttempts++;
          if (ambiguousAttempts > cfg.AMBIGUOUS_RETRIES) {
            // Stop for tonight. A day sitting incomplete for 24 hours costs
            // nothing; four copies in payroll costs a conversation.
            repo.releaseAmbiguous(ids, c.detail, null);
            stats.ambiguous += ids.length;
            // ms is the diagnosis here: a duration at the headers timeout
            // means the batch is too large, not that the network is unwell.
            log('publish.ambiguous.defer', { count: ids.length, ms: lastPostMs, detail: c.detail });
            stop = `ambiguous: ${c.detail}`;
            settled = true;
            break;
          }
          log('publish.ambiguous.retry', { count: ids.length, ms: lastPostMs, detail: c.detail });
          await sleep(backoffMs(ambiguousAttempts, cfg.BACKOFF_BASE_MS, cfg.BACKOFF_CAP_MS));
          continue;
        }

        // connect / transient: the request provably did not apply.
        attempt++;
        if (attempt >= cfg.MAX_ATTEMPTS) {
          repo.releaseUnblamed(ids, c.detail, null);
          log('publish.transient.defer', { count: ids.length, detail: c.detail });
          stop = `transient: ${c.detail}`;
          settled = true;
          break;
        }
        await sleep(c.retryAfterMs ?? backoffMs(attempt, cfg.BACKOFF_BASE_MS, cfg.BACKOFF_CAP_MS));
        continue;
      }

      if (verdict.kind === 'accepted') {
        repo.markSent(ids);
        stats.sent += ids.length;
        // The only log on the healthy path. Without it a successful run is
        // silent, and silence is also what a broken publisher looks like.
        log('publish.batch.sent', { count: ids.length, ms: lastPostMs });
        settled = true;
        break;
      }

      if (verdict.kind === 'too_large') {
        // Defensive: BATCH_SIZE is capped below the server limit, so this
        // should be unreachable. Halve and let the loop re-claim rather than
        // bisecting, which would hunt for a culprit that does not exist.
        repo.releaseUnblamed(ids, verdict.messages.join('; '), null);
        log('publish.too_large', { count: ids.length });
        stop = 'batch exceeded server cap';
        settled = true;
        break;
      }

      // ---- rejected --------------------------------------------------------
      // Preferred path: the server named the offending elements, so quarantine
      // exactly those and re-send the rest. Two calls, exact attribution.
      const named = verdict.failedIndices.filter((i) => i >= 0 && i < rows.length);
      if (named.length > 0 && named.length < rows.length) {
        const badIds = new Set(named.map((i) => rows[i]!.id));
        const survivors = rows.filter((r) => !badIds.has(r.id));

        repo.applyOutcomes(
          named.map((i) => ({
            swipeEventId: rows[i]!.id,
            accepted: false,
            // Structural rejection: the identical payload will be refused
            // identically, so nightly retries would be pure noise.
            //
            // This flag is the lever. `permanent: true` abandons on the first
            // rejection and skips quarantine entirely; it is correct only
            // because every documented ZingHR Code 0 is structural. If a
            // non-structural rejection is ever observed, set this to false and
            // the graduated quarantine ladder in repo.applyOutcomes takes over.
            permanent: true,
            message: verdict.messages.join('; '),
          })),
          cfg.MAX_ATTEMPTS,
          cfg.QUARANTINE_DAYS * 86_400_000,
        );
        stats.rejected += named.length;
        log('publish.rejected.indexed', { indices: named, messages: verdict.messages });

        // The survivors were never applied -- validation precedes insertion --
        // so return them to the queue for the next claim rather than assuming
        // partial delivery.
        repo.releaseUnblamed(survivors.map((r) => r.id), 'batch rejected; peer element invalid', null);
        settled = true;
        break;
      }

      // Fallback: a batch-scoped complaint with no index. Bisection is safe
      // here because the server judged the request rather than failing it.
      log('publish.bisect.start', { count: ids.length, messages: verdict.messages });

      let result;
      try {
        result = await bisect(rows, async (chunk) => {
          const v = await sendOnce(chunk.map(payloadOf));
          return v.kind === 'accepted'
            ? { accepted: true as const }
            : { accepted: false as const, messages: v.messages };
        });
      } catch (err) {
        // The network failed partway through the hunt. Some sub-batches may
        // have been accepted and we can no longer tell which, so treat the
        // whole batch as ambiguous and stop -- the alternative is stranding
        // these rows in_flight until the next run's crash reclaim.
        const c = classifySendError(err);
        if (c.kind === 'auth') {
          repo.releaseUnblamed(ids, c.detail, null);
          stats.abortedReason = `auth: ${c.detail}`;
          log('publish.abort', { reason: c.detail, during: 'bisect' });
          return stats;
        }
        repo.releaseAmbiguous(ids, c.detail, null);
        stats.ambiguous += ids.length;
        log('publish.bisect.failed', { count: ids.length, detail: c.detail });
        stop = `bisect interrupted: ${c.detail}`;
        break;
      }

      repo.markSent(result.accepted.map((r) => r.id));
      stats.sent += result.accepted.length;

      const outcomes: RecordOutcome[] = result.rejected.map((r) => ({
        swipeEventId: r.item.id,
        accepted: false,
        // Structural rejections are permanent: the identical payload will be
        // refused identically, so retrying it nightly is pure noise. As above,
        // this is the lever that would re-enable the quarantine ladder.
        permanent: true,
        message: r.messages.join('; '),
      }));
      repo.applyOutcomes(outcomes, cfg.MAX_ATTEMPTS, cfg.QUARANTINE_DAYS * 86_400_000);
      stats.rejected += outcomes.length;

      log('publish.bisect.done', {
        accepted: result.accepted.length,
        rejected: outcomes.length,
        calls: result.calls,
      });
      settled = true;
    }
  }

  if (stop && !stats.abortedReason) stats.abortedReason = stop;
  return stats;
}
