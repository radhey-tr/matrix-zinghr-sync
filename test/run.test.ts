import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, type Db } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import { runOnce } from '../src/run/index.ts';
import { acquireLock, LockHeldError } from '../src/run/lock.ts';
import { addDays, daysBetween, todayIso } from '../src/run/dates.ts';
import type { Config } from '../src/config.ts';
import type { Publisher } from '../src/run/publish.ts';

let db: Db, repo: Repo;

const cfg = {
  TIMEZONE: 'Asia/Kolkata', SWEEP_DAYS: 3, MAX_DAYS_PER_RUN: 5, BATCH_SIZE: 100,
  MAX_ATTEMPTS: 3, AMBIGUOUS_RETRIES: 1, QUARANTINE_DAYS: 7, STALL_DAYS: 3,
  BACKOFF_BASE_MS: 1, BACKOFF_CAP_MS: 1, DRY_RUN: false,
  COSEC_RESPONSE_KEY: 'template-data', COSEC_FIELD_EMP: 'userid',
  COSEC_FIELD_DATETIME: 'eventdatetime', COSEC_FIELD_UNIQUE: 'indexno',
  COSEC_FIELD_TERMINAL: 'mastercontrollerid', COSEC_FIELD_RECEIVED: 'idatetime',
  COSEC_DATETIME_FORMAT: 'MM/DD/YYYY HH:mm:ss',
} as unknown as Config;

const NOW = new Date('2026-08-26T02:00:00Z');
const YESTERDAY = addDays(todayIso(NOW, 'Asia/Kolkata'), -1);

const row = (idx: string, dateMMDDYYYY: string, emp = '2349') => ({
  userid: emp, indexno: idx, mastercontrollerid: '2113',
  eventdatetime: `${dateMMDDYYYY} 09:00:00`, idatetime: `${dateMMDDYYYY} 09:00:00`,
});

const acceptAll: Publisher = {
  authenticate: async () => 'tok',
  postBatch: async () => ({ kind: 'accepted' }),
};

const deps = (rowsFor: (f: string, t: string) => Array<Record<string, unknown>>, zing = acceptAll) => ({
  cfg, repo, zing, now: () => NOW,
  cosec: { fetchRange: async (f: string, t: string) => rowsFor(f, t) },
});

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new Repo(db);
});

describe('the nightly run', () => {
  test('stages yesterday and delivers it', async () => {
    const s = await runOnce(deps(() => [row('1', '08/25/2026'), row('2', '08/25/2026')]));
    assert.equal(s.outcome, 'ok');
    assert.equal(s.publish.sent, 2);
    assert.deepEqual(s.daysProcessed, [YESTERDAY]);
  });

  test('a COSEC failure leaves the day recoverable rather than losing it', async () => {
    const s = await runOnce(deps(() => { throw new Error('ECONNREFUSED'); }));
    assert.equal(s.outcome, 'partial');
    const day = repo.incompleteDays(5)[0];
    assert.equal(day?.state, 'pending', 'must retry tomorrow');
    assert.match(day?.last_error ?? '', /ECONNREFUSED/);
  });

  test('a malformed row is counted, not silently dropped, and does not fail the day', async () => {
    const s = await runOnce(deps(() => [
      row('1', '08/25/2026'),
      { userid: '', indexno: '2', eventdatetime: '08/25/2026 09:00:00' },
      { userid: '3', indexno: '3', eventdatetime: 'NOT A DATE' },
    ]));
    assert.equal(s.unmappable, 2);
    assert.equal(s.publish.sent, 1, 'the good row still goes');
    assert.equal(s.unmappableSamples.length, 2, 'reasons surface in the report');
  });
});

describe('the sweep is what catches late-arriving swipes', () => {
  test('a swipe appearing for an already-complete day reopens it and is sent', async () => {
    // Day one: the day job sees nothing.
    let s = await runOnce(deps((f, t) => (f === t ? [] : [])));
    assert.equal(repo.incompleteDays(9).length, 0, 'day settles complete with zero rows');

    // Day two: COSEC has now recorded a swipe that happened yesterday --
    // 22.9% of real swipes arrive this way.
    s = await runOnce(deps((f, t) => (f === t ? [] : [row('99', '08/25/2026')])));

    assert.equal(s.publish.sent, 1, 'the late swipe must reach ZingHR');
    assert.deepEqual(s.reopened, [YESTERDAY], 'and its day must reopen');
  });

  test('re-reading the same rows sends nothing the second time', async () => {
    const rows = [row('1', '08/25/2026'), row('2', '08/25/2026')];
    const first = await runOnce(deps(() => rows));
    assert.equal(first.publish.sent, 2);

    const second = await runOnce(deps(() => rows));
    assert.equal(second.publish.sent, 0, 're-reading must never re-send');
    assert.equal(second.publish.calls, 0, 'and must not even call ZingHR');
  });
});

describe('dry run', () => {
  test('stages everything and contacts ZingHR not at all', async () => {
    let called = false;
    const spy: Publisher = {
      authenticate: async () => { called = true; return 'tok'; },
      postBatch: async () => ({ kind: 'accepted' }),
    };
    const s = await runOnce({ ...deps(() => [row('1', '08/25/2026')], spy), cfg: { ...cfg, DRY_RUN: true } });
    assert.equal(called, false, 'DRY_RUN must never reach production payroll');
    assert.equal(s.publish.sent, 0);
    assert.equal(repo.pendingCount(), 1, 'but the work is staged and ready');
  });
});

describe('single-instance lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));

  test('a second run is refused while the first holds it', () => {
    const p = join(dir, 'a.lock');
    const held = acquireLock(p);
    assert.throws(() => acquireLock(p), LockHeldError);
    held.release();
    acquireLock(p).release();
  });

  test('a lock left by a dead process is reclaimed, not honoured forever', () => {
    const p = join(dir, 'b.lock');
    writeFileSync(p, '999999');  // a pid that cannot be running
    const lock = acquireLock(p);
    lock.release();
  });
});

describe('date arithmetic', () => {
  test('crosses month and year boundaries', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29', 'leap year');
  });

  test('spans are inclusive at both ends', () => {
    assert.deepEqual(daysBetween('2026-08-24', '2026-08-26'),
      ['2026-08-24', '2026-08-25', '2026-08-26']);
  });
});
