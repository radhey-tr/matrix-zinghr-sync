/**
 * Daily report, alerts, and heartbeat.
 *
 * The nightly report is sent whether or not anything went wrong. At one run a
 * night, silence is exactly what a dead job looks like, so a report that only
 * appears on failure is indistinguishable from a broken reporter.
 *
 * Tail runs are different: ~100 a day, and a report per tick would bury the
 * nightly one. A tail run carries only alerts about ITSELF (it failed, or
 * ZingHR refused its credentials); everything ledger-wide -- abandoned
 * swipes, stalled days, repeated ambiguity -- waits for the nightly, which is
 * also where a human is expected to read it.
 */
import { request } from 'undici';
import type { Config } from './config.ts';
import type { Repo } from './db/repo.ts';
import type { RunSummary } from './run/index.ts';

export interface Alert {
  severity: 'warn' | 'critical';
  title: string;
  detail: string;
}

export function buildAlerts(summary: RunSummary, repo: Repo, cfg: Config, now = Date.now()): Alert[] {
  const alerts: Alert[] = [];

  if (summary.outcome === 'failed') {
    alerts.push({
      severity: 'critical',
      title: `Sync run failed (${summary.mode})`,
      detail: summary.error ?? 'unknown',
    });
  }

  if (summary.publish.abortedReason?.startsWith('auth')) {
    // Named causes, because this will be diagnosed under time pressure and the
    // likely culprits are not obvious from a 401 alone.
    alerts.push({
      severity: 'critical',
      title: 'Authentication rejected',
      detail:
        `${summary.publish.abortedReason}. Likely: expired App Registration ` +
        `validity period, rotated client secret, or this host's IP not allowlisted.`,
    });
  }

  // Everything below is about the ledger rather than this run, and belongs
  // to the nightly report. See the header comment.
  if (summary.mode === 'tail') return alerts;

  if (summary.stalled.length) {
    alerts.push({
      severity: 'critical',
      title: `${summary.stalled.length} day(s) stalled`,
      detail: `Open beyond ${cfg.STALL_DAYS} days: ${summary.stalled.join(', ')}`,
    });
  }

  // The only path by which a swipe is permanently not delivered.
  const abandoned = repo.abandoned(Date.now() - 7 * 86_400_000);
  if (abandoned.length) {
    alerts.push({
      severity: 'critical',
      title: `${abandoned.length} swipe(s) abandoned`,
      detail: abandoned.slice(0, 5).map((a) => `${a.emp_identification}@${a.swipe_datetime}: ${a.last_error}`).join(' | '),
    });
  }

  const ambiguous = repo.ambiguousRecords(cfg.AMBIGUOUS_ALERT_AT);
  if (ambiguous.length) {
    alerts.push({
      severity: 'warn',
      title: `${ambiguous.length} swipe(s) with repeated ambiguous sends`,
      detail:
        `Each may have been delivered more than once. A handful a year is ` +
        `normal; a cluster indicates a network or capacity problem.`,
    });
  }

  if (summary.unmappable) {
    alerts.push({
      severity: 'warn',
      title: `${summary.unmappable} COSEC row(s) could not be mapped`,
      detail:
        `${summary.unmappableSamples.join(' | ')}. If this is sudden, the COSEC ` +
        `template may have changed — check COSEC_FIELD_* and COSEC_DATETIME_FORMAT.`,
    });
  }

  const lastNightly = repo.lastSuccessfulRunAt('nightly');
  const staleHours = lastNightly ? (now - lastNightly) / 3_600_000 : Infinity;
  if (staleHours > 24 + cfg.STALE_ALERT_GRACE_HOURS) {
    alerts.push({
      severity: 'critical',
      title: 'No successful nightly run in over 24 hours',
      detail: lastNightly ? `Last success ${staleHours.toFixed(1)}h ago` : 'No successful nightly run on record',
    });
  }

  // The tail's own failures are visible only here: a tail tick that fails
  // reports itself, but one that never runs at all reports nothing. This is
  // the nightly noticing on its behalf; the heartbeat is the external check.
  if (cfg.TAIL_SCHEDULE) {
    const lastTail = repo.lastSuccessfulRunAt('tail');
    const staleMin = lastTail ? (now - lastTail) / 60_000 : Infinity;
    if (staleMin > cfg.TAIL_STALE_ALERT_MINUTES) {
      alerts.push({
        severity: 'critical',
        title: `No successful tail run in over ${cfg.TAIL_STALE_ALERT_MINUTES} minutes`,
        detail: lastTail
          ? `Last success ${(staleMin / 60).toFixed(1)}h ago; intra-day swipes are not reaching ZingHR`
          : 'No successful tail run on record',
      });
    }
  }

  return alerts;
}

export function formatReport(summary: RunSummary, repo: Repo, cfg: Config, alerts: Alert[]): string {
  const L: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);

  L.push(`Matrix COSEC -> ZingHR swipe sync  [${cfg.ENVIRONMENT}]${cfg.DRY_RUN ? '  (DRY RUN)' : ''}`);
  L.push(`${summary.mode} run ${summary.correlationId}  ${new Date(summary.startedAt).toISOString()}  ${(summary.durationMs / 1000).toFixed(1)}s  -> ${summary.outcome.toUpperCase()}`);
  L.push('');

  if (alerts.length) {
    L.push('ALERTS');
    for (const a of alerts) L.push(`  [${a.severity.toUpperCase()}] ${a.title}\n      ${a.detail}`);
    L.push('');
  }

  L.push('DELIVERY');
  L.push(`  ${pad('COSEC rows (day fetch)', 28)}${summary.fetched}`);
  L.push(`  ${pad('COSEC rows (sweep re-read)', 28)}${summary.sweptRows}`);
  L.push(`  ${pad('newly staged', 28)}${summary.newlyStaged}`);
  L.push(`  ${pad('unmappable rows', 28)}${summary.unmappable}`);
  L.push(`  ${pad('accepted by ZingHR', 28)}${summary.publish.sent}`);
  L.push(`  ${pad('rejected', 28)}${summary.publish.rejected}`);
  L.push(`  ${pad('ambiguous (may duplicate)', 28)}${summary.publish.ambiguous}`);
  L.push(`  ${pad('still pending', 28)}${repo.pendingCount()}`);
  L.push(`  ${pad('POSTs / batches', 28)}${summary.publish.calls} / ${summary.publish.batches}`);
  if (summary.publish.calls > 0) {
    // Trend this against ZINGHR_HEADERS_TIMEOUT_MS. Approaching it means
    // BATCH_SIZE is too large: a timeout here is an ambiguous send, which is
    // the only failure mode that can put a swipe into payroll twice.
    L.push(
      `  ${pad('slowest POST', 28)}${(summary.publish.maxPostMs / 1000).toFixed(1)}s` +
      `  (${summary.publish.maxPostCount} rows)`,
    );
  }
  if (summary.publish.abortedReason) L.push(`  aborted: ${summary.publish.abortedReason}`);
  L.push('');

  // Everything the operator might need to act on, not just what this run
  // fetched: a day carrying pending work matters even if it was not touched.
  const days = repo.daySummaries(
    [...new Set([
      ...summary.daysProcessed, ...summary.reopened, ...summary.stalled,
      ...repo.incompleteDays(30).map((d) => d.attendance_date),
    ])].sort(),
  );
  if (days.length) {
    L.push('DAYS OPEN OR TOUCHED');
    L.push(`  ${pad('date', 14)}${pad('state', 12)}${pad('cosec', 8)}${pad('sent', 8)}quarantined`);
    for (const d of days) {
      L.push(
        `  ${pad(d.attendance_date, 14)}${pad(d.state, 12)}` +
        `${pad(String(d.cosec_count ?? '-'), 8)}${pad(String(d.sent_count), 8)}${d.quarantined_count}`,
      );
    }
    L.push('');
  }

  if (summary.pruned) {
    L.push(`RETENTION`);
    L.push(`  pruned ${summary.pruned} delivered swipe(s) past ${cfg.RETENTION_DAYS} days`);
    L.push('');
  }

  if (summary.mode === 'nightly') {
    L.push('SWEEP');
    L.push(`  re-read ${summary.sweptDays} day(s) from COSEC; reopened ${summary.reopened.length}`);
    L.push(`  (COSEC records ~23% of swipes >24h after the event, so this is load-bearing)`);
  }

  return L.join('\n');
}

/** Fire-and-forget delivery. A failed report must never fail the run. */
export async function deliver(
  cfg: Config,
  body: string,
  alerts: Alert[],
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  if (cfg.ALERT_WEBHOOK_URL) {
    const critical = alerts.some((a) => a.severity === 'critical');
    try {
      await request(cfg.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: (critical ? '🔴 ' : alerts.length ? '⚠️ ' : '✅ ') + '```\n' + body + '\n```' }),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
    } catch (err) {
      log('report.webhook.failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * External dead-man's switch. Pinged only on success, so its ABSENCE is the
 * signal -- internal monitoring cannot report its own death, and a nightly job
 * can be dead for a fortnight before anyone notices.
 *
 * Pinged from both cadences. With the tail on, the switch's expected period is
 * the tail interval plus grace (2 min + 5), not a day -- a stopped process
 * then surfaces in minutes rather than the following morning.
 */
export async function heartbeat(
  cfg: Config,
  ok: boolean,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  if (!cfg.HEARTBEAT_URL || !ok) return;
  try {
    await request(cfg.HEARTBEAT_URL, { method: 'GET', headersTimeout: 10_000, bodyTimeout: 10_000 });
  } catch (err) {
    log('heartbeat.failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
