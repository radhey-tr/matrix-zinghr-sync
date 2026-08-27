import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../src/db/index.ts';
import { Repo } from '../src/db/repo.ts';
import { publish, type Publisher } from '../src/run/publish.ts';
import { ZingAuthError } from '../src/zinghr.ts';
import type { Config } from '../src/config.ts';
import type { SyncVerdict } from '../src/zinghr.ts';
import type { ZingSwipe } from '../src/types.ts';

let db: Db;
let repo: Repo;

const cfg = {
  BATCH_SIZE: 10,
  MAX_ATTEMPTS: 3,
  AMBIGUOUS_RETRIES: 1,
  QUARANTINE_DAYS: 7,
  BACKOFF_BASE_MS: 1,
  BACKOFF_CAP_MS: 1,
} as unknown as Config;

const deps = (client: Publisher) => ({ repo, client, cfg, sleep: async () => {} });

/** Records a token per call so we can assert the one-token-per-POST rule. */
function fakeClient(handler: (swipes: ZingSwipe[]) => Promise<SyncVerdict>) {
  const state = { auths: 0, posts: 0, tokensUsed: [] as string[] };
  const client: Publisher = {
    authenticate: async () => `tok-${++state.auths}`,
    postBatch: async (swipes, token) => {
      state.posts++;
      state.tokensUsed.push(token);
      return handler(swipes);
    },
  };
  return { client, state };
}

const stage = (n: number) => {
  const rows = Array.from({ length: n }, (_, i) => ({
    attendanceDate: '2026-08-26',
    terminalId: 'T1',
    uniqueId: String(1000 + i),
    empIdentification: `EMP${String(i).padStart(3, '0')}`,
    swipeDateTime: `2026-08-26 09:${String(i % 60).padStart(2, '0')}:00`,
    payloadJson: JSON.stringify({
      empIdentification: `EMP${String(i).padStart(3, '0')}`,
      swipeDateTime: `2026-08-26 09:${String(i % 60).padStart(2, '0')}:00`,
    }),
  }));
  repo.stageSwipes(rows);
};

const states = () =>
  Object.fromEntries(
    (
      db.prepare('SELECT state, COUNT(*) AS n FROM swipe_event GROUP BY state').all() as Array<{
        state: string;
        n: number;
      }>
    ).map((r) => [r.state, r.n]),
  );

const netErr = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new Repo(db);
  repo.ensureDay('2026-08-26');
});

describe('happy path', () => {
  test('delivers every swipe and authenticates once per POST', async () => {
    stage(25);
    const { client, state } = fakeClient(async () => ({ kind: 'accepted' }));
    const stats = await publish(deps(client));

    assert.equal(stats.sent, 25);
    assert.equal(states()['sent'], 25);
    assert.equal(state.posts, 3, '25 swipes at BATCH_SIZE 10');
    assert.equal(state.auths, state.posts, 'a fresh token for every POST');
    assert.equal(new Set(state.tokensUsed).size, 3, 'no token is ever reused');
  });
});

describe('an outage must not blame the payload', () => {
  test('records return to pending with attempts untouched', async () => {
    stage(5);
    const { client } = fakeClient(async () => {
      throw netErr('ECONNREFUSED');
    });
    const stats = await publish(deps(client));

    assert.equal(stats.sent, 0);
    assert.equal(states()['pending'], 5, 'all recoverable tomorrow');

    const rows = db.prepare('SELECT attempts, ambiguous_count FROM swipe_event').all() as Array<{
      attempts: number;
      ambiguous_count: number;
    }>;
    for (const r of rows) {
      assert.equal(r.attempts, 0, 'an outage is not the record’s fault');
      assert.equal(r.ambiguous_count, 0, 'connect-phase failures are not ambiguous');
    }
  });

  test('an auth failure aborts the run and leaves everything recoverable', async () => {
    stage(30);
    let posts = 0;
    const client: Publisher = {
      authenticate: async () => 'tok',
      postBatch: async () => {
        if (++posts === 2) throw new ZingAuthError('Invalid client credentials', 401);
        return { kind: 'accepted' };
      },
    };
    const stats = await publish(deps(client));

    assert.match(stats.abortedReason ?? '', /auth/);
    assert.equal(stats.sent, 10, 'the first batch still counts as delivered');
    assert.equal(states()['pending'], 20, 'the rest stay pending for tomorrow');
  });
});

describe('ambiguous sends are handled timidly', () => {
  test('one retry, then defer — never the full ladder', async () => {
    stage(3);
    const { client, state } = fakeClient(async () => {
      throw netErr('UND_ERR_HEADERS_TIMEOUT');
    });
    const stats = await publish(deps(client));

    assert.equal(state.posts, 2, 'one send plus one retry; each retry can mint a duplicate');
    assert.equal(stats.ambiguous, 3);
    assert.equal(states()['pending'], 3);

    const rows = db.prepare('SELECT attempts, ambiguous_count FROM swipe_event').all() as Array<{
      attempts: number;
      ambiguous_count: number;
    }>;
    for (const r of rows) {
      assert.equal(r.ambiguous_count, 1, 'the possible duplicate is visible for reporting');
      assert.equal(r.attempts, 0, 'and still does not count against the record');
    }
  });

  test('an unparseable response is ambiguous, not success', async () => {
    stage(2);
    const { client } = fakeClient(async () => {
      // The server answered; we have no idea what it did.
      const { ZingProtocolError } = await import('../src/zinghr.ts');
      throw new ZingProtocolError('response was not JSON: <html>502</html>');
    });
    const stats = await publish(deps(client));

    assert.equal(stats.sent, 0, 'an unreadable body must never be treated as delivery');
    assert.equal(stats.ambiguous, 2);
  });
});

describe('a rejection naming its element skips bisection entirely', () => {
  test('quarantines the named index and returns the rest to the queue', async () => {
    stage(5);
    let call = 0;
    const { client, state } = fakeClient(async () => {
      // First call: the real server shape — HTTP 400, code 0, indexed data.
      if (++call === 1) {
        return {
          kind: 'rejected',
          messages: ['swipes[2].SwipeDateTime: SwipeDateTime must be in  yyyy-MM-dd HH:mm:ss format'],
          failedIndices: [2],
        };
      }
      return { kind: 'accepted' };
    });

    const stats = await publish(deps(client));

    assert.equal(stats.rejected, 1, 'exactly the named element');
    assert.equal(stats.sent, 4, 'the other four still get delivered');
    assert.equal(states()['abandoned'], 1);
    assert.equal(states()['sent'], 4);
    assert.equal(state.posts, 2, 'one rejection plus one resend — no bisection');
  });

  test('a batch-scoped complaint with no index still falls back to bisection', async () => {
    stage(8);
    const { client, state } = fakeClient(async (swipes) =>
      swipes.some((s) => s.empIdentification === 'EMP005')
        ? { kind: 'rejected', messages: ['Swipes required'], failedIndices: [] }
        : { kind: 'accepted' },
    );
    const stats = await publish(deps(client));
    assert.equal(stats.sent, 7);
    assert.equal(stats.rejected, 1);
    assert.ok(state.posts > 2, 'bisection remains available when nothing is named');
  });
});

describe('bisection fallback delivers the innocent', () => {
  test('isolates the culprit and sends the rest', async () => {
    stage(8);
    const poison = 'EMP005';
    const { client, state } = fakeClient(async (swipes) =>
      swipes.some((s) => s.empIdentification === poison)
        ? { kind: 'rejected', messages: ['SwipeDateTime is required'], failedIndices: [] }
        : { kind: 'accepted' },
    );

    const stats = await publish(deps(client));

    assert.equal(stats.sent, 7, 'seven good swipes must still land');
    assert.equal(stats.rejected, 1);
    assert.equal(states()['sent'], 7);
    assert.equal(states()['abandoned'], 1, 'structural rejections are permanent');
    assert.ok(state.posts > 1 && state.posts < 12, `expected a bisection, got ${state.posts} posts`);

    const bad = db
      .prepare("SELECT emp_identification, last_error FROM swipe_event WHERE state='abandoned'")
      .get() as { emp_identification: string; last_error: string };
    assert.equal(bad.emp_identification, poison);
    assert.match(bad.last_error, /SwipeDateTime/, 'the reason must survive for the report');
  });

  test('every POST during a bisection still gets its own token', async () => {
    stage(4);
    const { client, state } = fakeClient(async (swipes) =>
      swipes.some((s) => s.empIdentification === 'EMP002')
        ? { kind: 'rejected', messages: ['bad'], failedIndices: [] }
        : { kind: 'accepted' },
    );
    await publish(deps(client));
    assert.equal(state.auths, state.posts);
    assert.equal(new Set(state.tokensUsed).size, state.posts, 'no reuse under bisection either');
  });
});
