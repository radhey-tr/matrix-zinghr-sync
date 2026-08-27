/**
 * The nightly run.
 *
 * Ordering matters and each step earns its place:
 *
 *   reclaim  - a previous run died mid-batch; those rows are ambiguous, not lost
 *   requeue  - quarantined records get another chance (rarely fires in practice)
 *   stage    - fetch each incomplete day and land it in the ledger
 *   sweep    - RE-READ recent days. COSEC records ~23% of swipes more than a
 *              day after the event, so a "yesterday only" fetch would miss
 *              roughly a quarter of them. Re-reading is cheap and sends
 *              nothing: the identity column dedupes at the database level.
 *   reopen   - a settled day that the sweep found new work for
 *   publish  - drain to ZingHR, serially, one token per POST
 *   settle   - mark days complete, or stalled if they have been open too long
 */
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Repo } from '../db/repo.ts';
import { CosecClient, shapeFrom, toStageable, type CosecShape } from '../cosec.ts';
import { publish, type Publisher, type PublishStats } from './publish.ts';
import { addDays, daysBetween, todayIso } from './dates.ts';

export interface RunSummary {
  correlationId: string;
  outcome: 'ok' | 'partial' | 'failed';
  startedAt: number;
  durationMs: number;
  daysProcessed: string[];
  /** Rows returned by the per-day fetches. */
  fetched: number;
  /** Rows returned by the overlapping re-read sweep. Mostly already known. */
  sweptRows: number;
  /**
   * Swipes genuinely NEW to the ledger. The sweep deliberately re-reads rows
   * we already hold, so counting mapping operations would inflate this wildly
   * -- this is the insert-or-ignore result, i.e. what will actually be sent.
   */
  newlyStaged: number;
  unmappable: number;
  unmappableSamples: string[];
  sweptDays: number;
  reopened: string[];
  publish: PublishStats;
  stalled: string[];
  pruned: number;
  error?: string;
}

export interface RunDeps {
  cfg: Config;
  repo: Repo;
  cosec: Pick<CosecClient, 'fetchRange'>;
  zing: Publisher;
  log?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
}

export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const { cfg, repo, cosec, zing } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const shape: CosecShape = shapeFrom(cfg);
  // The sweep deliberately overlaps the day job, so the same malformed row is
  // seen more than once per run. Count distinct rows, or the report inflates.
  const seenBadRows = new Set<string>();

  const correlationId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const runId = repo.startRun(correlationId);

  const summary: RunSummary = {
    correlationId, outcome: 'ok', startedAt, durationMs: 0,
    daysProcessed: [], fetched: 0, sweptRows: 0, newlyStaged: 0,
    unmappable: 0, unmappableSamples: [],
    sweptDays: 0, reopened: [],
    publish: { batches: 0, calls: 0, sent: 0, rejected: 0, ambiguous: 0 },
    stalled: [], pruned: 0,
  };

  try {
    const reclaimed = repo.reclaimInFlight();
    if (reclaimed) log('run.reclaimed', { count: reclaimed });
    const requeued = repo.requeueQuarantined();
    if (requeued) log('run.requeued', { count: requeued });

    const today = todayIso(now(), cfg.TIMEZONE);
    const yesterday = addDays(today, -1);
    repo.ensureDay(yesterday);

    // ---- stage incomplete days, oldest first ------------------------------
    const pending = repo
      .incompleteDays(cfg.MAX_DAYS_PER_RUN)
      .filter((d) => d.state === 'pending');

    for (const day of pending) {
      try {
        const rows = await cosec.fetchRange(day.attendance_date, day.attendance_date);
        summary.fetched += rows.length;
        const staged = mapRows(rows, shape, summary, seenBadRows);
        summary.newlyStaged += repo.stageSwipes(staged);
        repo.markDayStaged(day.attendance_date, rows.length);
        summary.daysProcessed.push(day.attendance_date);
        log('run.staged', { date: day.attendance_date, rows: rows.length, mapped: staged.length });
      } catch (err) {
        // The day stays 'pending' and is retried tomorrow. Nothing is lost.
        const msg = err instanceof Error ? err.message : String(err);
        repo.markDayFetchFailed(day.attendance_date, msg);
        summary.outcome = 'partial';
        log('run.stage.failed', { date: day.attendance_date, error: msg });
      }
    }

    // ---- sweep: re-READ recent days, send only what is genuinely new ------
    // Fetched one day at a time rather than as a single range. COSEC does not
    // paginate -- it returns the entire span in one response, measured at 31MB
    // and ~200MB of heap for 158k rows -- so a multi-day range at production
    // volume would be a large, all-or-nothing download. Per-day requests bound
    // the memory, let one bad day fail without losing the rest, and make
    // progress visible in the log.
    if (cfg.SWEEP_DAYS > 0) {
      const from = addDays(yesterday, -cfg.SWEEP_DAYS);
      const span = daysBetween(from, yesterday);
      summary.sweptDays = span.length;
      let failures = 0;

      for (const d of span) {
        try {
          const rows = await cosec.fetchRange(d, d);
          summary.sweptRows += rows.length;
          const staged = mapRows(rows, shape, summary, seenBadRows);
          if (staged.length) repo.ensureDay(d);
          const added = repo.stageSwipes(staged);
          summary.newlyStaged += added;
          if (added) log('run.swept.day', { date: d, read: rows.length, newlyStaged: added });
        } catch (err) {
          // One day failing must not cost the other nine. Tomorrow's sweep
          // covers the same span again, so nothing is lost by continuing.
          failures++;
          log('run.sweep.day.failed', { date: d, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (failures) summary.outcome = 'partial';
      log('run.swept', {
        from, to: yesterday, days: span.length, read: summary.sweptRows,
        newlyStaged: summary.newlyStaged, failedDays: failures,
      });
    }

    summary.reopened = repo.reopenDaysWithPendingWork();
    if (summary.reopened.length) log('run.reopened', { dates: summary.reopened });

    // ---- publish ----------------------------------------------------------
    if (!cfg.DRY_RUN) {
      summary.publish = await publish({ repo, client: zing, cfg, log });
      if (summary.publish.abortedReason) summary.outcome = 'partial';
    } else {
      log('run.dry_run', { pending: repo.pendingCount() });
    }

    // ---- settle -----------------------------------------------------------
    // Must include days processed this run, not only days holding swipes: a
    // holiday or a closed site yields zero rows, and such a day would
    // otherwise never settle, sit incomplete forever, and eventually stall.
    const stallMs = cfg.STALL_DAYS * 86_400_000;
    const toSettle = new Set([...repo.daysWithWork(), ...summary.daysProcessed, ...summary.reopened]);
    for (const d of [...toSettle].sort()) {
      if (repo.settleDay(d, stallMs) === 'stalled') summary.stalled.push(d);
    }
    if (summary.stalled.length) summary.outcome = 'partial';

    // ---- prune ------------------------------------------------------------
    // Last, so a failure here cannot cost a run that has already delivered.
    const cutoff = addDays(today, -cfg.RETENTION_DAYS);
    summary.pruned = repo.pruneSent(cutoff);
    repo.pruneRunLog(Date.now() - cfg.RUN_LOG_RETENTION_DAYS * 86_400_000);
    if (summary.pruned) log('run.pruned', { before: cutoff, rows: summary.pruned });
  } catch (err) {
    summary.outcome = 'failed';
    summary.error = err instanceof Error ? err.message : String(err);
    log('run.failed', { error: summary.error });
  }

  summary.durationMs = Date.now() - startedAt;
  repo.finishRun(
    runId,
    summary.outcome,
    {
      days: summary.daysProcessed.length,
      fetched: summary.fetched,
      sent: summary.publish.sent,
      rejected: summary.publish.rejected,
      ambiguous: summary.publish.ambiguous,
    },
    summary.error,
  );
  return summary;
}

function mapRows(
  rows: Array<Record<string, unknown>>,
  shape: CosecShape,
  summary: RunSummary,
  seenBadRows: Set<string>,
): ReturnType<typeof toStageable>[] {
  const out: ReturnType<typeof toStageable>[] = [];
  for (const r of rows) {
    try {
      out.push(toStageable(r, shape));
    } catch (err) {
      // One malformed row must never fail a whole day, but it must be visible:
      // silently dropping swipes is the failure this system exists to prevent.
      const signature = JSON.stringify(r);
      if (seenBadRows.has(signature)) continue;
      seenBadRows.add(signature);
      summary.unmappable++;
      if (summary.unmappableSamples.length < 5) {
        summary.unmappableSamples.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return out;
}
