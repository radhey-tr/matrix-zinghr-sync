import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrate } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import { buildUrl, CosecError, parseRows, shapeFrom, toRangeToken, toStageable } from '../src/cosec.ts';
import { compileDateFormat, DateFormatError, parseDateTime } from '../src/cosec-fields.ts';
import type { Config } from '../src/config.ts';

const SAMPLE = readFileSync(new URL('./fixtures/cosec-sample.json', import.meta.url), 'utf8');

const cfg = {
  COSEC_BASE_URL: 'http://host:818/cosec/api.svc/v2/template-data',
  COSEC_TEMPLATE_ID: '133',
  COSEC_RESPONSE_KEY: 'template-data',
  COSEC_FIELD_EMP: 'userid',
  COSEC_FIELD_DATETIME: 'eventdatetime',
  COSEC_FIELD_UNIQUE: 'indexno',
  COSEC_FIELD_TERMINAL: 'mastercontrollerid',
  COSEC_FIELD_RECEIVED: 'idatetime',
  COSEC_FIELD_INOUT: 'entryexittype',
  COSEC_DATETIME_FORMAT: 'MM/DD/YYYY HH:mm:ss',
} as unknown as Config;

const shape = shapeFrom(cfg);
const rows = parseRows(SAMPLE, 'template-data');

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

describe('date format is declared, not assumed', () => {
  const us = compileDateFormat('MM/DD/YYYY HH:mm:ss');
  const uk = compileDateFormat('DD/MM/YYYY HH:mm:ss');

  test('the same string means different months under different patterns', () => {
    // The entire reason this is configuration. For the first twelve days of a
    // month the two are indistinguishable, and guessing wrong shifts
    // attendance by months with nothing anywhere reporting an error.
    assert.equal(parseDateTime('03/08/2026 09:00:00', us), '2026-03-08 09:00:00');
    assert.equal(parseDateTime('03/08/2026 09:00:00', uk), '2026-08-03 09:00:00');
  });

  test('handles ISO-style and dotted European patterns too', () => {
    assert.equal(
      parseDateTime('2026-08-26 14:33:54', compileDateFormat('YYYY-MM-DD HH:mm:ss')),
      '2026-08-26 14:33:54',
    );
    assert.equal(
      parseDateTime('26.08.2026 14:33:54', compileDateFormat('DD.MM.YYYY HH:mm:ss')),
      '2026-08-26 14:33:54',
    );
  });

  test('rejects a value that does not match the declared pattern', () => {
    for (const bad of ['2026-08-26 14:33:54', '8/26/2026 14:33:54', '08/26/2026', '13/45/2026 00:00:00']) {
      assert.throws(() => parseDateTime(bad, us), DateFormatError, `should reject ${bad}`);
    }
  });

  test('an incomplete pattern is refused at startup rather than at 00:30', () => {
    assert.throws(() => compileDateFormat('MM/DD/YYYY'), DateFormatError);
    assert.throws(() => compileDateFormat('MM/MM/YYYY HH:mm:ss'), DateFormatError);
  });
});

describe('response parsing', () => {
  test('reads the configured envelope key', () => {
    assert.equal(rows.length, 3);
  });

  test('a non-JSON body throws rather than staging a partial day', () => {
    assert.throws(() => parseRows('<html>502 Bad Gateway</html>', 'template-data'), CosecError);
  });

  test('a missing envelope key throws rather than yielding zero rows', () => {
    // Silently returning [] would mark the day complete with nothing sent.
    assert.throws(() => parseRows('{"data":[]}', 'template-data'), CosecError);
  });

  test('a renamed envelope key is a config change, not a code change', () => {
    assert.equal(parseRows('{"rows":[{"a":1}]}', 'rows').length, 1);
  });
});

describe('mapping to the ledger', () => {
  test('the configured identity column becomes the dedupe key', () => {
    const s = toStageable(rows[0]!, shape);
    assert.equal(s.uniqueId, '555270');
    assert.equal(s.empIdentification, '2349');
    assert.equal(s.swipeDateTime, '2026-08-01 05:58:10');
    assert.equal(s.attendanceDate, '2026-08-01');
    assert.equal(s.terminalId, '2113');
  });

  test('the sent payload carries the six mapped fields and nothing else', () => {
    const p = JSON.parse(toStageable(rows[0]!, shape).payloadJson);
    assert.deepEqual(Object.keys(p).sort(), [
      'empIdentification', 'inOutFlag', 'swipeDateTime',
      'swipeReceiveDateTime', 'terminalId', 'uniqueId',
    ]);
    assert.equal(p.swipeReceiveDateTime, '2026-08-06 15:21:34', 'reformatted like swipeDateTime');
    assert.equal(p.inOutFlag, '0', 'passed through verbatim, never interpreted');
    assert.ok(!('username' in p), 'employee names must never leave the building');
    assert.ok(!('template-id' in p));
  });

  test('an unreadable receive time drops that field, never the swipe', () => {
    // The batch is atomic, so emitting a malformed swipeReceiveDateTime would
    // reject every good swipe alongside it. Losing one optional field beats
    // losing the swipe, and beats losing its whole batch.
    const p = JSON.parse(toStageable({ ...rows[0]!, idatetime: 'GARBAGE' }, shape).payloadJson);
    assert.ok(!('swipeReceiveDateTime' in p), 'omitted rather than sent malformed');
    assert.equal(p.empIdentification, '2349', 'the swipe itself still delivers');
    assert.equal(p.swipeDateTime, '2026-08-01 05:58:10');
  });

  test('an absent receive time or direction is simply omitted', () => {
    const p = JSON.parse(
      toStageable({ ...rows[0]!, idatetime: '', entryexittype: '' }, shape).payloadJson,
    );
    assert.ok(!('swipeReceiveDateTime' in p));
    assert.ok(!('inOutFlag' in p));
  });

  test('either field can be switched off by clearing its config', () => {
    const off = shapeFrom({ ...cfg, COSEC_FIELD_RECEIVED: '', COSEC_FIELD_INOUT: '' } as unknown as Config);
    const p = JSON.parse(toStageable(rows[0]!, off).payloadJson);
    assert.deepEqual(Object.keys(p).sort(), ['empIdentification', 'swipeDateTime', 'terminalId', 'uniqueId']);
  });

  test('remapping every column is pure configuration', () => {
    // Simulates a production template with entirely different names.
    const renamed = { emp_code: 'E9', punch_at: '31/12/2026 23:59:59', row_id: 'R1', device: 'D7' };
    const alt = shapeFrom({
      ...cfg,
      COSEC_FIELD_EMP: 'emp_code',
      COSEC_FIELD_DATETIME: 'punch_at',
      COSEC_FIELD_UNIQUE: 'row_id',
      COSEC_FIELD_TERMINAL: 'device',
      COSEC_DATETIME_FORMAT: 'DD/MM/YYYY HH:mm:ss',
    } as unknown as Config);

    const s = toStageable(renamed, alt);
    assert.equal(s.empIdentification, 'E9');
    assert.equal(s.swipeDateTime, '2026-12-31 23:59:59');
    assert.equal(s.uniqueId, 'R1');
    assert.equal(s.terminalId, 'D7');
  });

  test('columns we do not use are ignored, present or absent', () => {
    // Template 133 briefly carried userid1/indexno1/username1/eventdatetime1
    // and then stopped, mid-development, without notice. Neither shape may
    // disturb the mapping.
    const withExtras = {
      ...rows[0]!,
      userid1: '2349', username1: 'SAMPLE NAME A', indexno1: '555270',
      eventdatetime1: '08/01/2026 05:58:10', somethingNew: 'x',
    };
    assert.deepEqual(
      JSON.parse(toStageable(withExtras, shape).payloadJson),
      JSON.parse(toStageable(rows[0]!, shape).payloadJson),
    );
  });

  test('a renamed column we DO depend on fails loudly, never silently', () => {
    // The failure that matters: if COSEC renames the identity or timestamp
    // column, every row must throw so the run reports thousands of unmappable
    // rows -- rather than staging swipes with a wrong or missing key.
    const renamed = { ...rows[0]! } as Record<string, unknown>;
    renamed['swipe_index'] = renamed['indexno'];
    delete renamed['indexno'];
    assert.throws(() => toStageable(renamed, shape), CosecError);
  });

  test('a row with no identity value is refused', () => {
    assert.throws(() => toStageable({ ...rows[0]!, indexno: '  ' }, shape), CosecError);
  });

  test('an absent terminal column degrades to UNKNOWN rather than failing', () => {
    const s = toStageable({ ...rows[0]!, mastercontrollerid: '' }, shape);
    assert.equal(s.terminalId, 'UNKNOWN');
  });
});

describe('two swipes one second apart are distinct records', () => {
  test('the identity column separates what a natural key would collapse', () => {
    // Rows 2 and 3 share userid, eventdatetime AND controller, differing only
    // by indexno. A userid+eventdatetime+controller key loses one of them --
    // measured at 6 such collisions across one month of real UAT data.
    const db = openDb(':memory:');
    migrate(db);
    const repo = new Repo(db);
    repo.ensureDay('2026-08-26');

    const mapped = rows.slice(1).map((r) => toStageable(r, shape));
    assert.equal(mapped[0]!.swipeDateTime, mapped[1]!.swipeDateTime, 'same second');
    assert.equal(mapped[0]!.terminalId, mapped[1]!.terminalId, 'same controller');

    assert.equal(repo.stageSwipes(mapped), 2, 'both must survive staging');
    assert.equal(repo.stageSwipes(mapped), 0, 're-reading is still a no-op');
  });
});
