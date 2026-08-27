/**
 * Operator CLI. Exists so that diagnosing this at 9am on payroll cutoff day
 * does not require reading the source.
 *
 *   doctor [date]   inspect COSEC's live shape and check the field mapping
 *   status          ledger state at a glance
 *   day <date>      detail for one attendance date
 *   reopen <date>   re-fetch and re-publish a settled day
 *   replay          return quarantined/abandoned swipes to the queue
 *   pending [n]     show payloads that would go next
 *   vacuum          reclaim disk space after pruning
 */
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db/index.ts';
import { Repo } from './db/repo.ts';
import { CosecClient, shapeFrom, toStageable } from './cosec.ts';
import { addDays, todayIso } from './run/dates.ts';

const cfg = loadConfig();
const db = openDb(cfg.DB_PATH);
migrate(db);
const repo = new Repo(db);

const [cmd = 'status', ...args] = process.argv.slice(2);
const pad = (s: string, n: number) => String(s).padEnd(n);

/**
 * The command to reach for when production COSEC stops looking like UAT.
 * Shows what the endpoint actually returns, which columns the current mapping
 * selects, and what each one would become — so a template change is diagnosed
 * in one run rather than inferred from a stack trace.
 */
async function doctor(date: string): Promise<void> {
  console.log(`COSEC doctor — ${date}\n`);
  console.log('configured mapping:');
  for (const [k, v] of [
    ['response key', cfg.COSEC_RESPONSE_KEY], ['employee code', cfg.COSEC_FIELD_EMP],
    ['timestamp', cfg.COSEC_FIELD_DATETIME], ['identity (dedupe)', cfg.COSEC_FIELD_UNIQUE],
    ['terminal', cfg.COSEC_FIELD_TERMINAL], ['received at', cfg.COSEC_FIELD_RECEIVED],
    ['date format', cfg.COSEC_DATETIME_FORMAT],
  ]) console.log(`  ${pad(k!, 20)}${v}`);

  const rows = await new CosecClient(cfg).fetchRange(date, date);
  console.log(`\nfetched ${rows.length} row(s)`);
  if (rows.length === 0) {
    console.log('  no rows — try another date before concluding the mapping is wrong');
    return;
  }

  const present = Object.keys(rows[0]!);
  console.log(`\ncolumns actually returned:\n  ${present.join(', ')}`);

  const wanted: Array<[string, string]> = [
    ['employee code', cfg.COSEC_FIELD_EMP],
    ['timestamp', cfg.COSEC_FIELD_DATETIME],
    ['identity', cfg.COSEC_FIELD_UNIQUE],
    ['terminal', cfg.COSEC_FIELD_TERMINAL],
  ];
  console.log('\nmapping check:');
  let broken = false;
  for (const [label, col] of wanted) {
    if (!col) { console.log(`  ${pad(label, 16)}(not configured)`); continue; }
    const ok = present.includes(col);
    if (!ok && label !== 'terminal') broken = true;
    console.log(`  ${pad(label, 16)}${pad(col, 24)}${ok ? 'OK' : '*** MISSING ***'}`);
  }

  // Identity is what makes re-reading safe; a non-unique column would cause
  // real swipes to be silently discarded as duplicates.
  const ids = rows.map((r) => String(r[cfg.COSEC_FIELD_UNIQUE] ?? ''));
  const distinct = new Set(ids).size;
  console.log(
    `\nidentity column "${cfg.COSEC_FIELD_UNIQUE}": ${distinct}/${ids.length} distinct` +
    (distinct === ids.length ? '  OK' : '  *** NOT UNIQUE — swipes would be lost to dedupe ***'),
  );

  const shape = shapeFrom(cfg);
  let mapped = 0;
  const errs: string[] = [];
  for (const r of rows) {
    try { toStageable(r, shape); mapped++; }
    catch (e) { if (errs.length < 3) errs.push(e instanceof Error ? e.message : String(e)); }
  }
  console.log(`\nmappable: ${mapped}/${rows.length}`);
  for (const e of errs) console.log(`  ! ${e}`);

  console.log('\nfirst row raw -> mapped:');
  console.log('  raw:    ' + JSON.stringify(rows[0]));
  try { console.log('  mapped: ' + toStageable(rows[0]!, shape).payloadJson); }
  catch (e) { console.log('  mapped: FAILED — ' + (e instanceof Error ? e.message : e)); }

  if (broken || mapped < rows.length) {
    console.log('\n=> Adjust COSEC_FIELD_* / COSEC_DATETIME_FORMAT in .env, then re-run doctor.');
    process.exitCode = 1;
  }
}

switch (cmd) {
  case 'doctor':
    await doctor(args[0] ?? addDays(todayIso(new Date(), cfg.TIMEZONE), -1));
    break;

  case 'status': {
    const last = repo.lastSuccessfulRunAt();
    console.log(`environment      ${cfg.ENVIRONMENT}${cfg.DRY_RUN ? '  (DRY RUN)' : ''}`);
    console.log(`last success     ${last ? new Date(last).toISOString() + `  (${((Date.now() - last) / 3600000).toFixed(1)}h ago)` : 'never'}`);
    console.log(`pending swipes   ${repo.pendingCount()}`);
    const stalled = repo.stalledDays();
    console.log(`stalled days     ${stalled.length ? stalled.map((d) => d.attendance_date).join(', ') : 'none'}`);
    const ab = repo.abandoned(0);
    console.log(`abandoned        ${ab.length}`);
    const amb = repo.ambiguousRecords(1);
    console.log(`ambiguous sends  ${amb.length}`);
    const pages = db.prepare('PRAGMA page_count').get() as { page_count: number };
    const psize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    const total = db.prepare('SELECT COUNT(*) n FROM swipe_event').get() as { n: number };
    console.log(`ledger           ${((pages.page_count * psize) / 1048576).toFixed(1)} MB, ${total.n} swipes, retention ${cfg.RETENTION_DAYS}d`);
    console.log('\nrecent days:');
    for (const d of repo.incompleteDays(20)) {
      console.log(`  ${pad(d.attendance_date, 14)}${pad(d.state, 12)}cosec=${pad(String(d.cosec_count ?? '-'), 8)}sent=${d.sent_count}`);
    }
    break;
  }

  case 'day': {
    const date = args[0];
    if (!date) { console.error('usage: day <YYYY-MM-DD>'); process.exit(2); }
    const rows = db
      .prepare(`SELECT state, COUNT(*) n FROM swipe_event WHERE attendance_date=? GROUP BY state`)
      .all(date) as Array<{ state: string; n: number }>;
    console.log(`${date}:`);
    for (const r of rows) console.log(`  ${pad(r.state, 14)}${r.n}`);
    if (!rows.length) console.log('  (no swipes staged)');
    break;
  }

  case 'reopen': {
    const date = args[0];
    if (!date) { console.error('usage: reopen <YYYY-MM-DD>'); process.exit(2); }
    db.prepare(`UPDATE sync_day SET state='pending', completed_at=NULL WHERE attendance_date=?`).run(date);
    console.log(`${date} set to pending — it will be re-fetched on the next run.`);
    console.log('Already-sent swipes are NOT re-sent; only genuinely new rows go out.');
    break;
  }

  case 'replay': {
    const n = db
      .prepare(`UPDATE swipe_event SET state='pending', next_attempt_at=NULL, attempts=0
                WHERE state IN ('quarantined','abandoned')`)
      .run().changes;
    console.log(`${n} swipe(s) returned to the queue.`);
    break;
  }

  case 'pending': {
    const limit = Number(args[0] ?? 10);
    const rows = db
      .prepare(`SELECT attendance_date, emp_identification, swipe_datetime, payload_json
                FROM swipe_event WHERE state='pending' ORDER BY attendance_date, id LIMIT ?`)
      .all(limit) as Array<Record<string, string>>;
    for (const r of rows) console.log(r.payload_json);
    console.log(`\n(${repo.pendingCount()} pending in total)`);
    break;
  }

  case 'vacuum': {
    // Pruning frees pages for reuse but does not shrink the file. Only worth
    // running if the disk is actually tight: VACUUM rewrites the whole
    // database and needs roughly its size again in temp space.
    const before = db.prepare('PRAGMA page_count').get() as { page_count: number };
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    console.log(`before: ${((before.page_count * pageSize) / 1048576).toFixed(1)} MB`);
    db.exec('VACUUM');
    const after = db.prepare('PRAGMA page_count').get() as { page_count: number };
    console.log(`after:  ${((after.page_count * pageSize) / 1048576).toFixed(1)} MB`);
    break;
  }

  default:
    console.error(`unknown command: ${cmd}`);
    console.error('try: doctor | status | day <date> | reopen <date> | replay | pending [n] | vacuum');
    process.exit(2);
}

db.close();
