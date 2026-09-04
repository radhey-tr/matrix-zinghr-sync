import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs,
  classifyHttpStatus,
  classifyNetworkError,
} from '../src/retry.ts';

const err = (code: string) => Object.assign(new Error(code), { code });

describe('phase classification', () => {
  test('connect-phase failures are safe to retry — the request never landed', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      const c = classifyNetworkError(err(code));
      assert.equal(c.kind, 'connect', `${code} should be connect-phase`);
      assert.equal(c.retryable, true);
      assert.equal(c.blamesRecord, false);
    }
  });

  test('response-phase failures are ambiguous — the write may have applied', () => {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNRESET']) {
      const c = classifyNetworkError(err(code));
      assert.equal(c.kind, 'ambiguous', `${code} should be ambiguous`);
    }
  });

  test('a response-phase code is downgraded to safe when the request never went out', () => {
    assert.equal(classifyNetworkError(err('ECONNRESET'), false).kind, 'connect');
  });

  test('unrecognised errors default to ambiguous, not transient', () => {
    // Assuming a failed request did nothing is the assumption that creates
    // duplicates, so the safe default is to admit we do not know.
    assert.equal(classifyNetworkError(err('SOMETHING_NEW')).kind, 'ambiguous');
  });
});

describe('http status classification', () => {
  test('5xx is transient and blames nobody — the server told us it did not apply', () => {
    const c = classifyHttpStatus(503);
    assert.equal(c.kind, 'transient');
    assert.equal(c.blamesRecord, false);
  });

  test('4xx blames the record and is not retried', () => {
    const c = classifyHttpStatus(422);
    assert.equal(c.kind, 'permanent');
    assert.equal(c.blamesRecord, true);
    assert.equal(c.retryable, false);
  });

  test('429 honours Retry-After', () => {
    assert.equal(classifyHttpStatus(429, '30').retryAfterMs, 30_000);
  });

  test('401 is auth-scoped, not a record fault', () => {
    assert.equal(classifyHttpStatus(401).kind, 'auth');
    assert.equal(classifyHttpStatus(401).blamesRecord, false);
  });
});

describe('backoff', () => {
  test('full jitter stays within [0, min(cap, base*2^n))', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const hi = backoffMs(attempt, 1000, 60_000, () => 0.999999);
      const lo = backoffMs(attempt, 1000, 60_000, () => 0);
      assert.equal(lo, 0, 'full jitter must be able to return ~0');
      assert.ok(hi <= 60_000, `attempt ${attempt} exceeded cap: ${hi}`);
      assert.ok(hi <= 1000 * 2 ** attempt, `attempt ${attempt} exceeded ceiling`);
    }
  });
});
