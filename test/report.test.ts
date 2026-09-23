import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import { buildAlerts, formatReport } from '../src/report.ts';
import type { RunSummary } from '../src/run/index.ts';
import type { Config } from '../src/config.ts';
import type { RunMode } from '../src/types.ts';

let db: Db, repo: Repo;

const cfg = {
  ENVIRONMENT: 'uat', DRY_RUN: false, STALL_DAYS: 3, AMBIGUOUS_ALERT_AT: 5,
  STALE_ALERT_GRACE_HOURS: 2, TAIL_SCHEDULE: '*/2 * * * *', TAIL_STALE_ALERT_MINUTES: 10,
  RETENTION_DAYS: 180,
} as unknown as Config;

const summary = (mode: RunMode, over: Partial<RunSummary> = {}): RunSummary => ({
  correlationId: 'abcd1234', mode, outcome: 'ok', startedAt: Date.now(), durationMs: 10,
  daysProcessed: [], fetched: 0, sweptRows: 0, newlyStaged: 0, unmappable: 0, unmappableSamples: [],
  sweptDays: 0, reopened: [],
  publish: { batches: 0, calls: 0, sent: 0, rejected: 0, ambiguous: 0, maxPostMs: 0, maxPostCount: 0 },
  stalled: [], pruned: 0,
  ...over,
});

/** Record a successful run of `mode` that finished `agoMs` ago. */
const succeededAgo = (mode: RunMode, agoMs: number) => {
  const id = repo.startRun('x', mode);
  repo.finishRun(id, 'ok', {});
  db.prepare('UPDATE run_log SET finished_at = ? WHERE id = ?').run(Date.now() - agoMs, id);
};

const titles = (a: ReturnType<typeof buildAlerts>) => a.map((x) => x.title);

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new Repo(db);
});

describe('tail runs alert only about themselves', () => {
  test('ledger-wide conditions are the nightly report’s business', () => {
    // Stage an abandoned swipe: a critical, ledger-wide alert.
    repo.ensureDay('2026-08-26');
    repo.stageSwipes([{
      attendanceDate: '2026-08-26', terminalId: 'T', uniqueId: '1', empIdentification: 'E',
      swipeDateTime: '2026-08-26 09:00:00', payloadJson: '{}',
    }]);
    const [row] = repo.claimBatch(1);
    repo.applyOutcomes([{ swipeEventId: row!.id, accepted: false, permanent: true, message: 'bad' }], 5, 0);
    succeededAgo('nightly', 60_000);
    succeededAgo('tail', 60_000);

    const nightly = buildAlerts(summary('nightly'), repo, cfg);
    assert.ok(titles(nightly).some((t) => t.includes('abandoned')), 'the nightly reports it');

    const tail = buildAlerts(summary('tail'), repo, cfg);
    assert.deepEqual(tail, [], 'a tail tick every 2 minutes must not repeat it ~700 times a day');
  });

  test('a tail run that fails, or is refused by ZingHR, does alert', () => {
    succeededAgo('nightly', 60_000);
    succeededAgo('tail', 60_000);

    const failed = buildAlerts(summary('tail', { outcome: 'failed', error: 'boom' }), repo, cfg);
    assert.deepEqual(titles(failed), ['Sync run failed (tail)']);

    const auth = buildAlerts(summary('tail', {
      outcome: 'partial',
      publish: { batches: 0, calls: 0, sent: 0, rejected: 0, ambiguous: 0, maxPostMs: 0, maxPostCount: 0, abortedReason: 'auth: HTTP 401' },
    }), repo, cfg);
    assert.deepEqual(titles(auth), ['Authentication rejected']);
  });
});

describe('each cadence has its own staleness check', () => {
  test('a stopped tail is noticed by the nightly', () => {
    succeededAgo('nightly', 3_600_000);
    succeededAgo('tail', 3 * 3_600_000);
    const t = titles(buildAlerts(summary('nightly'), repo, cfg));
    assert.ok(t.some((x) => x.startsWith('No successful tail run')));
    assert.ok(!t.some((x) => x.startsWith('No successful nightly run')));
  });

  test('a healthy tail does not mask a missing nightly', () => {
    // The tail succeeding every 2 minutes says nothing about whether the
    // sweep, settle and prune happened -- the old single check would have.
    succeededAgo('nightly', 30 * 3_600_000);
    succeededAgo('tail', 60_000);
    const t = titles(buildAlerts(summary('nightly'), repo, cfg));
    assert.ok(t.some((x) => x.startsWith('No successful nightly run')));
    assert.ok(!t.some((x) => x.startsWith('No successful tail run')));
  });

  test('with the tail disabled, its staleness is not an alert', () => {
    succeededAgo('nightly', 60_000);
    const t = titles(buildAlerts(summary('nightly'), repo, { ...cfg, TAIL_SCHEDULE: '' }));
    assert.deepEqual(t, []);
  });
});

describe('the report names its cadence', () => {
  test('so a tail alert is not mistaken for the nightly report', () => {
    const r = formatReport(summary('tail'), repo, cfg, []);
    assert.match(r, /^.*\ntail run abcd1234/);
    assert.ok(!r.includes('SWEEP'), 'the tail does not sweep and must not claim to');
    assert.ok(formatReport(summary('nightly'), repo, cfg, []).includes('SWEEP'));
  });
});
