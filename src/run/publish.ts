/**
 * The publisher: drains pending swipes to ZingHR, strictly serially.
 *
 * Serial is a hard constraint, not a tuning choice. Issuing a ZingHR token
 * invalidates the previous one, so two concurrent batches would void each
 * other's credentials and produce 401s that depend on timing -- a bug that
 * passes every small-data test and fails only at production volume.
 *
 * The three outcomes are deliberately handled differently:
 *
 *   accepted   -> mark sent, done.
 *   rejected   -> the server judged the batch and declined; bisect to find the
 *                 culprit so the innocent records still get delivered.
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

  const stats: PublishStats = { batches: 0, calls: 0, sent: 0, rejected: 0, ambiguous: 0 };

  // One fresh token per POST. At a ~2 minute TTL, caching would mean comparing
  // their `exp` against our clock, where a minute of drift is half the budget.
  const sendOnce = async (swipes: ZingSwipe[]): Promise<SyncVerdict> => {
    stats.calls++;
    const token = await client.authenticate();
    return client.postBatch(swipes, token);
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
            log('publish.ambiguous.defer', { count: ids.length, detail: c.detail });
            stop = `ambiguous: ${c.detail}`;
            settled = true;
            break;
          }
          log('publish.ambiguous.retry', { count: ids.length, detail: c.detail });
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

      // Rejected. The server judged it, so bisection is safe and terminating.
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
        // refused identically, so retrying it nightly is pure noise.
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
