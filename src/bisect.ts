/**
 * Isolating a poison record when the server rejects a batch without saying
 * which element was at fault.
 *
 * Every documented ZingHR Code 0 message is a batch-level structural complaint
 * with no element index, so a rejection tells us only that *something* in the
 * batch is bad. Splitting and retrying halves finds the culprit in ~log2(n)
 * requests -- about 8 for a batch of 200 -- instead of n single-record calls.
 *
 * Only ever run this on a verdict the server actually returned. Bisecting a
 * transport failure would multiply load against a service already struggling,
 * and bisecting an ambiguous timeout would multiply duplicates.
 */

export interface BisectResult<T> {
  /** Items the server accepted along the way. */
  accepted: T[];
  /** Items individually rejected -- these are the genuinely bad ones. */
  rejected: Array<{ item: T; messages: string[] }>;
  /** How many server round trips it took. */
  calls: number;
}

export type BisectVerdict = { accepted: true } | { accepted: false; messages: string[] };

/**
 * `send` must return a verdict for the whole chunk. It is called with
 * progressively smaller slices; a single-element rejection identifies a
 * culprit exactly.
 */
export async function bisect<T>(
  items: T[],
  send: (chunk: T[]) => Promise<BisectVerdict>,
): Promise<BisectResult<T>> {
  const out: BisectResult<T> = { accepted: [], rejected: [], calls: 0 };

  const walk = async (chunk: T[]): Promise<void> => {
    if (chunk.length === 0) return;

    out.calls++;
    const verdict = await send(chunk);

    if (verdict.accepted) {
      out.accepted.push(...chunk);
      return;
    }

    if (chunk.length === 1) {
      // Cannot subdivide further: this element is the problem.
      out.rejected.push({ item: chunk[0]!, messages: verdict.messages });
      return;
    }

    const mid = Math.floor(chunk.length / 2);
    // Sequential, not parallel: publishing is single-flight because issuing a
    // new ZingHR token invalidates the previous one.
    await walk(chunk.slice(0, mid));
    await walk(chunk.slice(mid));
  };

  await walk(items);
  return out;
}
