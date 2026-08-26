import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../src/db/index.ts';
import { Repo, type StageableSwipe } from '../src/db/repo.ts';

let db: Db;
let repo: Repo;

const swipe = (over: Partial<StageableSwipe> = {}): StageableSwipe => ({
  attendanceDate: '2026-08-19',
  terminalId: 'Terminal1',
  uniqueId: '1212',
  empIdentification: 'EMP001',
  swipeDateTime: '2026-08-19 14:09:51',
  payloadJson: '{}',
  ...over,
});

const stateOf = (id: number) =>
  db.prepare('SELECT state, attempts, ambiguous_count FROM swipe_event WHERE id = ?').get(id) as {
    state: string;
    attempts: number;
    ambiguous_count: number;
  };

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new Repo(db);
  repo.ensureDay('2026-08-19');
});

describe('staging and dedupe', () => {
  test('re-reading a day COSEC already gave us inserts nothing', () => {
    assert.equal(repo.stageSwipes([swipe()]), 1);
    assert.equal(repo.stageSwipes([swipe()]), 0, 'second read must be a no-op');
    assert.equal(repo.stageSwipes([swipe(), swipe({ uniqueId: '1213' })]), 1, 'only the new row');
  });

  test('identical uniqueId on different terminals are distinct swipes', () => {
    repo.stageSwipes([swipe({ terminalId: 'T1' }), swipe({ terminalId: 'T2' })]);
    const n = db.prepare('SELECT COUNT(*) AS n FROM swipe_event').get() as { n: number };
    assert.equal(n.n, 2, 'scoping dedupe to uniqueId alone would lose a real swipe');
  });
});

describe('attempt counting is scoped to blame', () => {
  test('batch-scoped failures return records to the queue WITHOUT blaming them', () => {
    repo.stageSwipes([swipe()]);
    const [row] = repo.claimBatch(10);
    assert.ok(row);
    repo.releaseUnblamed([row.id], 'HTTP 503', null);

    // Simulate a long outage: many claim/release cycles, none the record's fault.
    for (let i = 0; i < 50; i++) {
      const [claimed] = repo.claimBatch(10);
      assert.ok(claimed, 'record must stay claimable throughout an outage');
      repo.releaseUnblamed([claimed.id], 'HTTP 503', null);
    }

    const after = stateOf(row.id);
    assert.equal(after.attempts, 0, 'an outage must never advance the record attempt count');
    assert.equal(after.state, 'pending', 'and must never abandon a blameless record');
  });

  test('a rejection naming the record does advance it, up to abandonment', () => {
    repo.stageSwipes([swipe()]);
    const [row] = repo.claimBatch(10);
    assert.ok(row);

    repo.applyOutcomes([{ swipeEventId: row.id, accepted: false, message: 'unknown employee' }], 3, 0);
    assert.equal(stateOf(row.id).attempts, 1);
    assert.equal(stateOf(row.id).state, 'quarantined');

    repo.applyOutcomes([{ swipeEventId: row.id, accepted: false }], 3, 0);
    repo.applyOutcomes([{ swipeEventId: row.id, accepted: false }], 3, 0);
    assert.equal(stateOf(row.id).state, 'abandoned', 'exhausted record-scoped attempts');
  });

  test('a permanent rejection abandons immediately without burning retries', () => {
    repo.stageSwipes([swipe()]);
    const [row] = repo.claimBatch(10);
    assert.ok(row);
    repo.applyOutcomes(
      [{ swipeEventId: row.id, accepted: false, permanent: true, message: 'malformed' }],
      5,
      0,
    );
    assert.equal(stateOf(row.id).state, 'abandoned');
  });
});

describe('ambiguity is tracked apart from blame', () => {
  test('an ambiguous release counts separately and never abandons', () => {
    repo.stageSwipes([swipe()]);
    const [row] = repo.claimBatch(10);
    assert.ok(row);
    repo.releaseAmbiguous([row.id], 'UND_ERR_HEADERS_TIMEOUT', null);

    const after = stateOf(row.id);
    assert.equal(after.ambiguous_count, 1);
    assert.equal(after.attempts, 0, 'the record is not at fault for a timeout');
    assert.equal(after.state, 'pending');
  });

  test('crash recovery reclaims in-flight rows and flags them as ambiguous', () => {
    repo.stageSwipes([swipe(), swipe({ uniqueId: '1213' })]);
    repo.claimBatch(10);
    assert.equal(repo.reclaimInFlight(), 2, 'both rows recovered after a crash');

    const rows = db
      .prepare('SELECT state, ambiguous_count FROM swipe_event')
      .all() as Array<{ state: string; ambiguous_count: number }>;
    for (const r of rows) {
      assert.equal(r.state, 'pending');
      assert.equal(r.ambiguous_count, 1, 'the batch may have landed before the crash');
    }
  });
});

describe('day settlement', () => {
  test('a day completes only once nothing is open', () => {
    repo.stageSwipes([swipe(), swipe({ uniqueId: '1213' })]);
    assert.equal(repo.settleDay('2026-08-19', 1e9), 'open');

    const rows = repo.claimBatch(10);
    repo.markSent(rows.map((r) => r.id));
    assert.equal(repo.settleDay('2026-08-19', 1e9), 'complete');
  });

  test('quarantined records hold the day open — they are still being retried', () => {
    repo.stageSwipes([swipe()]);
    const [row] = repo.claimBatch(10);
    assert.ok(row);
    repo.applyOutcomes([{ swipeEventId: row.id, accepted: false }], 5, 0);
    assert.equal(repo.settleDay('2026-08-19', 1e9), 'open');
  });

  test('a day open past its threshold stalls for a human', () => {
    repo.stageSwipes([swipe()]);
    assert.equal(repo.settleDay('2026-08-19', -1), 'stalled');
  });
});
