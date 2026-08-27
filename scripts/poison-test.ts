/**
 * Live verification of the indexed-rejection path against ZingHR UAT.
 *
 * Stages five valid swipes plus one whose timestamp ZingHR will refuse,
 * bypassing our own validation (which would normally catch it) so the SERVER
 * gets to judge. Confirms end to end that:
 *
 *   - the batch is rejected atomically, naming swipes[N]
 *   - that one record is quarantined
 *   - the other five are re-sent and delivered
 *   - it takes two POSTs, not a bisection
 */
import { openDb, migrate } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import { ZingHrClient } from '../src/zinghr.ts';
import { publish } from '../src/run/publish.ts';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig({ ...process.env, DB_PATH: ':memory:', DRY_RUN: 'false' });
const db = openDb(':memory:');
migrate(db);
const repo = new Repo(db);
repo.ensureDay('2026-08-26');

const stamp = Date.now().toString().slice(-6);
const mk = (i: number, dt: string) => ({
  attendanceDate: '2026-08-26',
  terminalId: 'POISONTEST',
  uniqueId: `${stamp}-${i}`,
  empIdentification: '2127',
  swipeDateTime: dt,
  payloadJson: JSON.stringify({ empIdentification: '2127', swipeDateTime: dt }),
});

// Index 3 is deliberately malformed. Staged directly, since transform.ts
// would refuse it -- the point is to let the server render the verdict.
repo.stageSwipes([
  mk(0, '2026-08-26 07:00:00'),
  mk(1, '2026-08-26 07:01:00'),
  mk(2, '2026-08-26 07:02:00'),
  mk(3, 'NOT-A-TIMESTAMP'),
  mk(4, '2026-08-26 07:04:00'),
  mk(5, '2026-08-26 07:05:00'),
]);

const events: string[] = [];
const stats = await publish({
  repo,
  client: new ZingHrClient(cfg),
  cfg: { ...cfg, BATCH_SIZE: 10 },
  log: (e, d) => events.push(`${e} ${JSON.stringify(d)}`),
});

console.log('events:');
for (const e of events) console.log('  ' + e);

console.log('\nstats:', JSON.stringify(stats));
const rows = db
  .prepare('SELECT unique_id, state, last_error FROM swipe_event ORDER BY unique_id')
  .all() as Array<{ unique_id: string; state: string; last_error: string | null }>;
console.log('\nledger:');
for (const r of rows) {
  console.log(`  ${r.unique_id.padEnd(12)} ${r.state.padEnd(12)} ${r.last_error ?? ''}`);
}

const sent = rows.filter((r) => r.state === 'sent').length;
const dead = rows.filter((r) => r.state === 'abandoned').length;
console.log(
  `\nRESULT: ${sent} delivered, ${dead} quarantined, ${stats.calls} POSTs — ` +
  (sent === 5 && dead === 1 && stats.calls === 2 ? 'PASS' : 'UNEXPECTED'),
);
db.close();
