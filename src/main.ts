/**
 * Entry point: a long-running process with two internal schedules.
 *
 *   SCHEDULE       the nightly run -- stage yesterday, sweep, settle, prune, report
 *   TAIL_SCHEDULE  the tail -- fetch today, publish; every 2 minutes by default
 *
 * Deliberately not an external cron invoking a script -- a resident process
 * keeps warm connections, holds the lock, and can be supervised with
 * restart-on-exit so recovery needs no human. With two cadences it also lets
 * them be serialised in-process: the nightly WAITS for a tail tick that
 * happens to be running at 00:30, rather than being skipped for the day.
 *
 *   node --experimental-strip-types src/main.ts --once         one nightly run
 *   node --experimental-strip-types src/main.ts --once --tail  one tail run
 */
import { Cron } from 'croner';
import { loadConfig } from './config.ts';
import { makeLogger } from './logger.ts';
import { migrate, openDb } from './db/index.ts';
import { Repo } from './db/repo.ts';
import { CosecClient } from './cosec.ts';
import { ZingHrClient } from './zinghr.ts';
import { runOnce, runTail } from './run/index.ts';
import { makeSerialiser } from './run/serialise.ts';
import { acquireLock, LockHeldError } from './run/lock.ts';
import { buildAlerts, deliver, formatReport, heartbeat } from './report.ts';
import type { RunMode } from './types.ts';

const cfg = loadConfig();
const logger = makeLogger(cfg);
const log = (event: string, detail: Record<string, unknown>) => logger.info(detail, event);

const db = openDb(cfg.DB_PATH);
const applied = migrate(db);
if (applied.length) logger.info({ applied }, 'db.migrated');

const repo = new Repo(db);
const cosec = new CosecClient(cfg);
const zing = new ZingHrClient(cfg);

// A tail alert would otherwise repeat every 2 minutes for as long as the
// cause persists -- ZingHR rejecting credentials would be ~700 identical
// messages a day. Send each distinct set once, and let the nightly report
// (which always goes out) restate anything still true.
let lastTailAlertKey = '';

async function tick(mode: RunMode): Promise<void> {
  let lock;
  try {
    lock = acquireLock(cfg.LOCK_PATH);
  } catch (err) {
    if (err instanceof LockHeldError) {
      // Another PROCESS holds it (a `--once` or CLI invocation). Runs within
      // this process never reach here; see `serialised` below.
      logger.warn({ mode, reason: err.message }, 'run.skipped');
      return;
    }
    throw err;
  }

  try {
    const summary = mode === 'tail'
      ? await runTail({ cfg, repo, cosec, zing, log })
      : await runOnce({ cfg, repo, cosec, zing, log });
    const alerts = buildAlerts(summary, repo, cfg);

    logger[summary.outcome === 'ok' ? 'info' : 'warn'](
      {
        mode, outcome: summary.outcome, fetched: summary.fetched,
        newlyStaged: summary.newlyStaged, sent: summary.publish.sent,
        alerts: alerts.length, ms: summary.durationMs,
      },
      'run.finished',
    );

    if (mode === 'nightly') {
      const report = formatReport(summary, repo, cfg, alerts);
      console.log('\n' + report + '\n');
      await deliver(cfg, report, alerts, log);
      lastTailAlertKey = '';
    } else if (alerts.length) {
      const key = alerts.map((a) => a.title).join('|');
      if (key !== lastTailAlertKey) {
        lastTailAlertKey = key;
        await deliver(cfg, formatReport(summary, repo, cfg, alerts), alerts, log);
      }
    }

    await heartbeat(cfg, summary.outcome !== 'failed', log);
  } finally {
    lock.release();
  }
}

// Serialises the two schedules in-process; rules and rationale in
// run/serialise.ts. A busy tail is logged at debug because it is expected
// under load: at production volume a late-day fetch can take ~10s, and a slow
// COSEC or a long drain can outlast the 2-minute interval.
const serialised = makeSerialiser(tick, {
  onBusy: (mode) => logger.debug({ mode }, 'run.busy'),
  onWaiting: (mode) => logger.info({ mode }, 'run.waiting'),
});

const tailOnly = process.argv.includes('--tail');
const once = process.argv.includes('--once') || tailOnly;

if (once) {
  await tick(tailOnly ? 'tail' : 'nightly');
  db.close();
} else {
  logger.info(
    {
      schedule: cfg.SCHEDULE, tailSchedule: cfg.TAIL_SCHEDULE || null,
      timezone: cfg.TIMEZONE, dryRun: cfg.DRY_RUN, env: cfg.ENVIRONMENT,
    },
    'scheduler.started',
  );

  const jobs = [
    new Cron(cfg.SCHEDULE, { timezone: cfg.TIMEZONE, name: 'nightly' }, () => {
      serialised('nightly').catch((err) => logger.error({ mode: 'nightly', err: String(err) }, 'run.unhandled'));
    }),
  ];
  if (cfg.TAIL_SCHEDULE) {
    jobs.push(
      new Cron(cfg.TAIL_SCHEDULE, { timezone: cfg.TIMEZONE, name: 'tail' }, () => {
        serialised('tail').catch((err) => logger.error({ mode: 'tail', err: String(err) }, 'run.unhandled'));
      }),
    );
  }
  for (const job of jobs) {
    logger.info({ job: job.name, next: job.nextRun()?.toISOString() }, 'scheduler.next');
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      logger.info({ sig }, 'scheduler.stopping');
      for (const job of jobs) job.stop();
      db.close();
      process.exit(0);
    });
  }
}
