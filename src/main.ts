/**
 * Entry point: a long-running process with an internal schedule.
 *
 * Deliberately not an external cron invoking a script -- a resident process
 * keeps warm connections, holds the lock, and can be supervised with
 * restart-on-exit so recovery needs no human.
 *
 *   node --experimental-strip-types src/main.ts --once
 */
import { Cron } from 'croner';
import { loadConfig } from './config.ts';
import { makeLogger } from './logger.ts';
import { migrate, openDb } from './db/index.ts';
import { Repo } from './db/repo.ts';
import { CosecClient } from './cosec.ts';
import { ZingHrClient } from './zinghr.ts';
import { runOnce } from './run/index.ts';
import { acquireLock, LockHeldError } from './run/lock.ts';
import { buildAlerts, deliver, formatReport, heartbeat } from './report.ts';

const cfg = loadConfig();
const logger = makeLogger(cfg);
const log = (event: string, detail: Record<string, unknown>) => logger.info(detail, event);

const db = openDb(cfg.DB_PATH);
const applied = migrate(db);
if (applied.length) logger.info({ applied }, 'db.migrated');

const repo = new Repo(db);
const cosec = new CosecClient(cfg);
const zing = new ZingHrClient(cfg);

async function tick(): Promise<void> {
  let lock;
  try {
    lock = acquireLock(cfg.LOCK_PATH);
  } catch (err) {
    if (err instanceof LockHeldError) {
      // Not an error: the previous run is still going. Skipping is correct --
      // two concurrent runs would void each other's ZingHR tokens.
      logger.warn({ reason: err.message }, 'run.skipped');
      return;
    }
    throw err;
  }

  try {
    const summary = await runOnce({ cfg, repo, cosec, zing, log });
    const alerts = buildAlerts(summary, repo, cfg);
    const report = formatReport(summary, repo, cfg, alerts);

    logger[summary.outcome === 'ok' ? 'info' : 'warn'](
      { outcome: summary.outcome, sent: summary.publish.sent, alerts: alerts.length },
      'run.finished',
    );
    console.log('\n' + report + '\n');

    await deliver(cfg, report, alerts, log);
    await heartbeat(cfg, summary.outcome !== 'failed', log);
  } finally {
    lock.release();
  }
}

const once = process.argv.includes('--once');

if (once) {
  await tick();
  db.close();
} else {
  logger.info(
    { schedule: cfg.SCHEDULE, timezone: cfg.TIMEZONE, dryRun: cfg.DRY_RUN, env: cfg.ENVIRONMENT },
    'scheduler.started',
  );
  const job = new Cron(cfg.SCHEDULE, { timezone: cfg.TIMEZONE }, () => {
    tick().catch((err) => logger.error({ err: String(err) }, 'run.unhandled'));
  });
  logger.info({ next: job.nextRun()?.toISOString() }, 'scheduler.next');

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      logger.info({ sig }, 'scheduler.stopping');
      job.stop();
      db.close();
      process.exit(0);
    });
  }
}
