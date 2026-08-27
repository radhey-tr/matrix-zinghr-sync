/**
 * Single-instance lock.
 *
 * Overlapping runs would double the load on both APIs and, worse, interleave
 * token refreshes -- and issuing a ZingHR token invalidates the previous one,
 * so two concurrent runs would void each other's credentials.
 *
 * The lock also lets crash recovery be trivial: because only one run can exist,
 * anything left `in_flight` belongs to a run that died, and can be reclaimed
 * unconditionally at startup. That is why there are no lease columns anywhere.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';

export class LockHeldError extends Error {}

export interface Lock {
  release(): void;
}

/** True when a pid is alive. Signal 0 tests existence without delivering. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(path: string): Lock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release() {
          try { rmSync(path, { force: true }); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        throw new LockHeldError(`another run is active (pid ${holder})`);
      }
      // Stale: the holder died without releasing. Clear it and retry once.
      // Left alone this would block every future run silently.
      rmSync(path, { force: true });
    }
  }
  throw new LockHeldError('could not acquire lock');
}
