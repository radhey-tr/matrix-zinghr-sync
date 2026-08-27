import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSyncBody, ZingProtocolError } from '../src/zinghr.ts';
import { bisect, type BisectVerdict } from '../src/bisect.ts';
import { toZingSwipe, TransformError } from '../src/transform.ts';

describe('sync response interpretation', () => {
  test('Code 1 is the ONLY thing that means delivered', () => {
    assert.deepEqual(interpretSyncBody('{"Message":"Success","Code":1,"Data":null}'), {
      kind: 'accepted',
    });
  });

  test('Code 0 is a rejection even though the HTTP status was 200', () => {
    const v = interpretSyncBody(
      '{"Message":"Failed","Code":0,"Data":{"error":"EmpIdentification is required"}}',
    );
    assert.equal(v.kind, 'rejected');
    assert.ok(
      v.kind === 'rejected' && v.messages.some((m) => m.includes('EmpIdentification')),
      'validation detail must survive into the verdict for the report',
    );
  });

  test('a stringified Code still parses — gateways coerce numerics', () => {
    assert.equal(interpretSyncBody('{"Message":"ok","Code":"1"}').kind, 'accepted');
  });

  test('the 5000 cap is distinguished from a poison record', () => {
    // Splitting fixes this; bisecting for a culprit would never terminate usefully.
    const v = interpretSyncBody(
      '{"Message":"Maximum 5000 swipes are allowed at a time","Code":0}',
    );
    assert.equal(v.kind, 'too_large');
  });

  test('a non-JSON body is an error, never an assumed success', () => {
    assert.throws(() => interpretSyncBody('<html>502 Bad Gateway</html>'), ZingProtocolError);
  });

  test('a JSON body without Code is an error, never an assumed success', () => {
    assert.throws(() => interpretSyncBody('{"status":"ok"}'), ZingProtocolError);
  });
});

describe('bisection isolates the poison record', () => {
  const send = (bad: Set<number>) => async (chunk: number[]): Promise<BisectVerdict> =>
    chunk.some((n) => bad.has(n))
      ? { accepted: false, messages: ['SwipeDateTime is required'] }
      : { accepted: true };

  test('finds one bad record among 200 in logarithmic calls', async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const res = await bisect(items, send(new Set([137])));

    assert.deepEqual(res.rejected.map((r) => r.item), [137]);
    assert.equal(res.accepted.length, 199, 'every good record must still be delivered');
    assert.ok(res.calls < 25, `expected ~log2(200) calls, got ${res.calls}`);
  });

  test('handles several bad records without losing the good ones', async () => {
    const items = Array.from({ length: 64 }, (_, i) => i);
    const res = await bisect(items, send(new Set([0, 31, 63])));

    assert.deepEqual(res.rejected.map((r) => r.item).sort((a, b) => a - b), [0, 31, 63]);
    assert.equal(res.accepted.length, 61);
  });

  test('an all-good batch costs exactly one call', async () => {
    const res = await bisect([1, 2, 3], send(new Set()));
    assert.equal(res.calls, 1);
    assert.equal(res.rejected.length, 0);
  });
});

describe('client-side validation makes the documented errors unreachable', () => {
  const ok = { empIdentification: 'EMP001', swipeDateTime: '2026-08-19 14:09:51' };

  test('accepts a valid swipe and passes the timestamp through byte-for-byte', () => {
    const out = toZingSwipe(ok);
    assert.equal(out.swipeDateTime, '2026-08-19 14:09:51');
    assert.equal(out.empIdentification, 'EMP001');
  });

  test('rejects what ZingHR would reject, before it can poison a batch', () => {
    assert.throws(() => toZingSwipe({ ...ok, empIdentification: '  ' }), TransformError);
    assert.throws(() => toZingSwipe({ ...ok, empIdentification: 'x'.repeat(21) }), TransformError);
    assert.throws(() => toZingSwipe({ ...ok, swipeDateTime: '2026-08-19T14:09:51' }), TransformError);
    assert.throws(() => toZingSwipe({ ...ok, swipeDateTime: '19-08-2026 14:09:51' }), TransformError);
  });

  test('does not forward swipeReceiveDateTime — it adds a batch-fatal format check for no gain', () => {
    const out = toZingSwipe({ ...ok, swipeReceiveDateTime: 'garbage', uniqueId: '1212' });
    assert.ok(!('swipeReceiveDateTime' in out));
    assert.equal(out.uniqueId, '1212');
  });

  test('drops an over-long terminalId rather than failing the swipe — it is optional', () => {
    const out = toZingSwipe({ ...ok, terminalId: 'T'.repeat(51) });
    assert.ok(!('terminalId' in out));
  });
});

describe('envelope casing — docs say PascalCase, the live API returns camelCase', () => {
  // Captured verbatim from UAT on 2026-08-26. Keying off the documented casing
  // would have thrown on every real call.
  const LIVE_SUCCESS =
    '{"code":1,"totalEmployeeCount":null,"svg":0,"data":null,"message":"Success",' +
    '"transactionID":null,"lastCachedAt":null,"cachedTill":null}';

  test('the real UAT success response is understood', () => {
    assert.deepEqual(interpretSyncBody(LIVE_SUCCESS), { kind: 'accepted' });
  });

  test('the documented PascalCase shape still parses', () => {
    assert.deepEqual(interpretSyncBody('{"Code":1,"Message":"Success","Data":null}'), {
      kind: 'accepted',
    });
  });

  test('a camelCase rejection keeps its validation detail', () => {
    const v = interpretSyncBody(
      '{"code":0,"message":"Failed","data":{"error":"SwipeDateTime is required"}}',
    );
    assert.equal(v.kind, 'rejected');
    assert.ok(v.kind === 'rejected' && v.messages.some((m) => m.includes('SwipeDateTime')));
  });

  test('unknown extra fields do not break the parse', () => {
    assert.equal(interpretSyncBody('{"code":1,"svg":0,"whatever":123}').kind, 'accepted');
  });

  test('a JSON array is refused rather than coerced', () => {
    assert.throws(() => interpretSyncBody('[{"code":1}]'), ZingProtocolError);
  });
});

describe('rejections name the offending element (observed on UAT)', () => {
  test('parses the index out of a real validation response', () => {
    // Verbatim from UAT 2026-08-27. The PDF's error table shows only bare
    // message strings, which is why bisection was built first.
    const v = interpretSyncBody(
      '{"code":0,"totalEmployeeCount":null,"svg":0,' +
      '"data":{"swipes[1].SwipeDateTime":["SwipeDateTime must be in  yyyy-MM-dd HH:mm:ss format"]},' +
      '"message":"Validation Error","transactionID":null}',
    );
    assert.equal(v.kind, 'rejected');
    assert.deepEqual(v.kind === 'rejected' && v.failedIndices, [1]);
  });

  test('collects several distinct indices, de-duplicated and ordered', () => {
    const v = interpretSyncBody(
      '{"code":0,"message":"Validation Error","data":{' +
      '"swipes[7].EmpIdentification":["\'Emp Identification\' must not be empty."],' +
      '"swipes[2].SwipeDateTime":["SwipeDateTime is required"],' +
      '"swipes[2].EmpIdentification":["EmpIdentification is required"]}}',
    );
    assert.deepEqual(v.kind === 'rejected' && v.failedIndices, [2, 7]);
  });

  test('a batch-scoped complaint names no index, so bisection stays reachable', () => {
    const v = interpretSyncBody('{"code":0,"message":"Validation Error","data":{"swipes":["Swipes required"]}}');
    assert.equal(v.kind, 'rejected');
    assert.deepEqual(v.kind === 'rejected' && v.failedIndices, []);
  });

  test('the 5000-cap message is still distinguished from a poison record', () => {
    assert.equal(
      interpretSyncBody('{"code":0,"message":"Maximum 5000 swipes are allowed at a time"}').kind,
      'too_large',
    );
  });

  test('a malformed root key gives HTTP 500 with a null data — no index to find', () => {
    const v = interpretSyncBody(
      '{"code":0,"data":null,"message":"An unexpected error occurred."}',
    );
    assert.equal(v.kind, 'rejected');
    assert.deepEqual(v.kind === 'rejected' && v.failedIndices, []);
  });
});
