/**
 * End-to-end dry run against real COSEC UAT data: fetch a range, map it, stage
 * it in a scratch ledger, and report what WOULD be sent. Never calls ZingHR.
 *
 *   node --experimental-strip-types scripts/dry-run.ts 2026-08-20 2026-08-26
 */
import { openDb, migrate } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import { CosecClient, toStageable } from '../src/cosec.ts';
import { loadConfig } from '../src/config.ts';

const [from = '2026-08-20', to = '2026-08-26'] = process.argv.slice(2);

const cfg = loadConfig({
  COSEC_BASE_URL: 'http://111.93.87.11:818/cosec/api.svc/v2/template-data',
  COSEC_USERNAME: 'sm',
  COSEC_PASSWORD: 'admin123',
  ZINGHR_AUTH_URL: 'https://mservices-uat.zinghr.com/etl/api/v2/Auth/GenerateJWTToken',
  ZINGHR_SYNC_URL: 'https://mservices-uat.zinghr.com/etl/api/v2/TNA/SynSwipes',
  ZINGHR_USERNAME: 'unused-in-dry-run',
  ZINGHR_PASSWORD: 'unused-in-dry-run',
  ENVIRONMENT: 'uat',
  DB_PATH: ':memory:',
  ...process.env,
});

const db = openDb(':memory:');
migrate(db);
const repo = new Repo(db);

console.log(`fetching COSEC ${from} .. ${to}`);
const t0 = Date.now();
const { rows } = await new CosecClient(cfg).fetchRange(from, to);
console.log(`  ${rows.length} rows in ${Date.now() - t0}ms\n`);

const staged: ReturnType<typeof toStageable>[] = [];
const bad: string[] = [];
for (const r of rows) {
  try { staged.push(toStageable(r, cfg.COSEC_EMP_FIELD)); }
  catch (e) { bad.push(e instanceof Error ? e.message : String(e)); }
}

for (const d of new Set(staged.map((s) => s.attendanceDate))) repo.ensureDay(d);
const inserted = repo.stageSwipes(staged);
const again = repo.stageSwipes(staged);

const byDay = new Map<string, number>();
for (const s of staged) byDay.set(s.attendanceDate, (byDay.get(s.attendanceDate) ?? 0) + 1);

console.log(`mapped:        ${staged.length}`);
console.log(`unmappable:    ${bad.length}${bad.length ? '  e.g. ' + bad[0] : ''}`);
console.log(`staged (new):  ${inserted}`);
console.log(`re-stage:      ${again}  <- must be 0; proves re-reading is free\n`);
console.log('per attendance date:');
for (const [d, n] of [...byDay].sort()) console.log(`  ${d}  ${String(n).padStart(4)}`);

const claimed = repo.claimBatch(3);
console.log(`\nfirst ${claimed.length} payloads that would go to ZingHR:`);
for (const c of claimed) console.log('  ' + c.payload_json);
