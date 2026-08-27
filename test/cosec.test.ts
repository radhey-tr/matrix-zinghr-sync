import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrate } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import {
  buildUrl, CosecError, parseRows, toRangeToken, toStageable, toZingDateTime,
} from '../src/cosec.ts';
import type { Config } from '../src/config.ts';

const SAMPLE = readFileSync(new URL('./fixtures/cosec-sample.json', import.meta.url), 'utf8');

const cfg = {
  COSEC_BASE_URL: 'http://host:818/cosec/api.svc/v2/template-data',
  COSEC_TEMPLATE_ID: '133',
  COSEC_EMP_FIELD: 'userid',
} as unknown as Config;

describe('query string uses semicolons, not ampersands', () => {
  test('builds the exact shape COSEC expects', () => {
    assert.equal(
      buildUrl(cfg, '2026-08-26', '2026-08-26'),
      'http://host:818/cosec/api.svc/v2/template-data?action=get;id=133;date-range=26082026-26082026;format=json',
    );
  });

  test('no ampersand ever appears — URLSearchParams would break this endpoint', () => {
    assert.ok(!buildUrl(cfg, '2026-08-01', '2026-08-26').includes('&'));
  });

  test('range tokens are DDMMYYYY, which is NOT the ISO field order', () => {
    assert.equal(toRangeToken('2026-08-26'), '26082026');
    assert.equal(toRangeToken('2026-01-02'), '02012026');
    assert.throws(() => toRangeToken('26-08-2026'), CosecError);
  });
});

describe('timestamp conversion MM/DD/YYYY -> yyyy-MM-dd', () => {
  test('converts without going near a Date object', () => {
    assert.equal(toZingDateTime('08/26/2026 14:33:54'), '2026-08-26 14:33:54');
    assert.equal(toZingDateTime('01/02/2026 00:00:00'), '2026-01-02 00:00:00');
  });

  test('a day-first reading would be wrong — 08/26 is August 26th', () => {
    // If this ever flips to DD/MM the error is silent and shifts attendance
    // by months, so pin the interpretation down explicitly.
    assert.equal(toZingDateTime('08/26/2026 14:33:54').slice(0, 10), '2026-08-26');
  });

  test('rejects anything that is not the expected shape', () => {
    for (const bad of ['2026-08-26 14:33:54', '8/26/2026 14:33:54', '08/26/2026', '13/45/2026 00:00:00']) {
      assert.throws(() => toZingDateTime(bad), CosecError, `should reject ${bad}`);
    }
  });
});

describe('response parsing', () => {
  test('reads the hyphenated template-data envelope', () => {
    assert.equal(parseRows(SAMPLE).length, 3);
  });

  test('a non-JSON body throws rather than staging a partial day', () => {
    assert.throws(() => parseRows('<html>502 Bad Gateway</html>'), CosecError);
  });

  test('an unexpected envelope throws rather than yielding zero rows', () => {
    // Silently returning [] would mark the day complete with nothing sent.
    assert.throws(() => parseRows('{"data":[]}'), CosecError);
  });
});

describe('mapping to the ledger', () => {
  const rows = parseRows(SAMPLE);

  test('indexno becomes the dedupe identity', () => {
    const s = toStageable(rows[0]!, 'userid');
    assert.equal(s.uniqueId, '555270');
    assert.equal(s.empIdentification, '2349');
    assert.equal(s.swipeDateTime, '2026-08-01 05:58:10');
    assert.equal(s.attendanceDate, '2026-08-01');
    assert.equal(s.terminalId, '2113');
  });

  test('the sent payload carries only what ZingHR uses, plus traceability', () => {
    const p = JSON.parse(toStageable(rows[0]!, 'userid').payloadJson);
    assert.deepEqual(Object.keys(p).sort(), ['empIdentification', 'swipeDateTime', 'terminalId', 'uniqueId']);
    assert.ok(!('username' in p), 'employee names must never leave the building');
    assert.ok(!('entryexittype' in p));
  });

  test('the employee field is configurable, since the mapping is unconfirmed', () => {
    assert.equal(toStageable(rows[0]!, 'indexno').empIdentification, '555270');
  });

  test('a row with no indexno is refused — it would have no stable identity', () => {
    assert.throws(() => toStageable({ ...rows[0]!, indexno: '  ' }, 'userid'), CosecError);
  });
});

describe('two swipes one second apart are distinct records', () => {
  test('indexno separates what a natural key would collapse', () => {
    // Rows 2 and 3 share userid, eventdatetime AND controller, differing only
    // by indexno. A userid+eventdatetime+controller key loses one of them --
    // measured at 6 such collisions across one month of real UAT data.
    const db = openDb(':memory:');
    migrate(db);
    const repo = new Repo(db);
    repo.ensureDay('2026-08-26');

    const rows = parseRows(SAMPLE).slice(1).map((r) => toStageable(r, 'userid'));
    assert.equal(rows[0]!.swipeDateTime, rows[1]!.swipeDateTime, 'same second');
    assert.equal(rows[0]!.terminalId, rows[1]!.terminalId, 'same controller');

    assert.equal(repo.stageSwipes(rows), 2, 'both must survive staging');
    assert.equal(repo.stageSwipes(rows), 0, 're-reading is still a no-op');
  });
});
