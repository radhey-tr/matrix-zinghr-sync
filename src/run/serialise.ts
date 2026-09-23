/**
 * In-process serialisation of the two schedules.
 *
 * Both cadences mutate the same ledger and would interleave ZingHR tokens, so
 * only one may run at a time. The file lock enforces that ACROSS processes;
 * this enforces it within one, and -- unlike the lock -- it can distinguish
 * the two cadences, which have opposite correct answers to a collision:
 *
 *   tail     skips. The next tick is two minutes away and re-reads the same
 *            day, so nothing is lost by standing down.
 *   nightly  waits. It fires once a day; skipping it would lose the sweep,
 *            settle and prune for 24 hours.
 *
 * The lock cannot make that distinction -- it only knows "held" -- which is
 * why this exists rather than leaning on the lock alone.
 */
import type { RunMode } from '../types.ts';

export interface SerialiseHooks {
  /** A tail tick stood down because a run was already in progress. */
  onBusy?: (mode: RunMode) => void;
  /** The nightly is waiting for an in-flight run before starting. */
  onWaiting?: (mode: RunMode) => void;
}

/**
 * Wrap a run function so concurrent invocations serialise by the rules above.
 *
 * The returned function rejects only for the run it actually started, never
 * for the one it waited on -- see the `.catch` below.
 */
export function makeSerialiser(
  run: (mode: RunMode) => Promise<void>,
  hooks: SerialiseHooks = {},
): (mode: RunMode) => Promise<void> {
  let inProgress: Promise<void> | null = null;

  return async function serialised(mode: RunMode): Promise<void> {
    if (inProgress) {
      if (mode === 'tail') {
        hooks.onBusy?.(mode);
        return;
      }
      hooks.onWaiting?.(mode);
      // Wait for it to SETTLE, not to succeed. A bare `await inProgress`
      // adopts the other run's rejection, so a tail tick that threw at
      // 00:29 would propagate here and the nightly would never start --
      // skipping it for 24 hours, which is the one outcome this whole
      // function exists to prevent. The failing run is reported by its own
      // caller; it is not this run's business.
      await inProgress.catch(() => {});
    }
    inProgress = run(mode).finally(() => {
      inProgress = null;
    });
    return inProgress;
  };
}
