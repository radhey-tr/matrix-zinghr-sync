import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeSerialiser } from '../src/run/serialise.ts';
import type { RunMode } from '../src/types.ts';

/** A run whose completion the test controls. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records which modes actually started, and hands back controllable runs. */
function harness() {
  const started: RunMode[] = [];
  const busy: RunMode[] = [];
  const waiting: RunMode[] = [];
  const gates: Array<ReturnType<typeof deferred>> = [];

  const serialised = makeSerialiser(
    (mode) => {
      started.push(mode);
      const g = deferred();
      gates.push(g);
      return g.promise;
    },
    { onBusy: (m) => busy.push(m), onWaiting: (m) => waiting.push(m) },
  );

  return { started, busy, waiting, gates, serialised };
}

/** Let queued microtasks drain so awaits resume before we assert. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe('a collision between the two cadences', () => {
  test('the tail stands down while a run is in progress', async () => {
    const h = harness();

    const nightly = h.serialised('nightly');
    await settle();
    assert.deepEqual(h.started, ['nightly']);

    await h.serialised('tail');
    assert.deepEqual(h.started, ['nightly'], 'the tail must not have started');
    assert.deepEqual(h.busy, ['tail']);

    h.gates[0]!.resolve();
    await nightly;
  });

  test('the nightly waits its turn rather than standing down', async () => {
    const h = harness();

    const tail = h.serialised('tail');
    await settle();
    assert.deepEqual(h.started, ['tail']);

    const nightly = h.serialised('nightly');
    await settle();
    assert.deepEqual(h.started, ['tail'], 'not yet -- the tail still holds it');
    assert.deepEqual(h.waiting, ['nightly']);

    h.gates[0]!.resolve();
    await settle();
    assert.deepEqual(h.started, ['tail', 'nightly'], 'and then it runs');

    h.gates[1]!.resolve();
    await Promise.all([tail, nightly]);
  });

  test('a tail tick that THROWS must not take the nightly down with it', async () => {
    // The regression this file exists for. `await inProgress` adopts the
    // other run's rejection, so a tail that threw at 00:29 would propagate
    // into the waiting nightly, which would then never start -- losing the
    // sweep, settle and prune for a full day, and logging it against the
    // nightly as though the nightly were the thing that broke.
    const h = harness();

    const tail = h.serialised('tail');
    await settle();

    const nightly = h.serialised('nightly');
    await settle();
    assert.deepEqual(h.waiting, ['nightly']);

    h.gates[0]!.reject(new Error('COSEC exploded mid-tick'));
    await assert.rejects(tail, /COSEC exploded/, 'the tail still reports its own failure');

    await settle();
    assert.deepEqual(h.started, ['tail', 'nightly'], 'the nightly must still run');

    h.gates[1]!.resolve();
    await nightly;
  });

  test('the nightly propagates its OWN failure, having swallowed the other', async () => {
    const h = harness();
    const nightly = h.serialised('nightly');
    await settle();
    h.gates[0]!.reject(new Error('nightly broke'));
    await assert.rejects(nightly, /nightly broke/);
  });
});

describe('after a run finishes', () => {
  test('the gate reopens, so the next tick is not blocked forever', async () => {
    const h = harness();

    const first = h.serialised('tail');
    await settle();
    h.gates[0]!.resolve();
    await first;

    const second = h.serialised('tail');
    await settle();
    assert.deepEqual(h.started, ['tail', 'tail'], 'a later tick runs normally');
    assert.deepEqual(h.busy, [], 'and was never told it was busy');

    h.gates[1]!.resolve();
    await second;
  });

  test('the gate reopens even when the run failed', async () => {
    const h = harness();

    const first = h.serialised('tail');
    await settle();
    h.gates[0]!.reject(new Error('boom'));
    await assert.rejects(first);
    await settle();

    const second = h.serialised('tail');
    await settle();
    assert.deepEqual(h.started, ['tail', 'tail'], 'one failure must not wedge the scheduler');

    h.gates[1]!.resolve();
    await second;
  });

  test('a tail cannot slip in between a finishing run and the waiting nightly', async () => {
    // The handover is microtask-only, so a timer-driven tick cannot land in
    // the gap. Asserted because it is the kind of invariant that silently
    // stops holding if the handover ever grows an await.
    const h = harness();

    const tail = h.serialised('tail');
    await settle();
    const nightly = h.serialised('nightly');
    await settle();

    h.gates[0]!.resolve();
    await settle();

    await h.serialised('tail');
    assert.deepEqual(h.started, ['tail', 'nightly'], 'the nightly took the slot, not the tail');
    assert.deepEqual(h.busy, ['tail'], 'the newcomer was turned away');

    h.gates[1]!.resolve();
    await Promise.all([tail, nightly]);
  });
});
