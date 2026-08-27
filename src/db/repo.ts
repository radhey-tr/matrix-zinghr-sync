/**
 * All ledger access. Every state transition in the design lives here as a named
 * method, so the rules are enforced in one place rather than spread across the
 * pipeline stages.
 */
import type { Db } from './index.ts';
import type { RecordOutcome, SwipeEventRow, SyncDayRow } from '../types.ts';

export interface StageableSwipe {
  attendanceDate: string;
  terminalId: string;
  uniqueId: string;
  empIdentification: string;
  swipeDateTime: string;
  payloadJson: string;
}

export class Repo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- day jobs ----------------------------------------------------------

  ensureDay(date: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_day (attendance_date, state, created_at)
         VALUES (?, 'pending', ?)
         ON CONFLICT (attendance_date) DO NOTHING`,
      )
      .run(date, Date.now());
  }

  /** Incomplete days, oldest first, bounded so a long outage drains steadily. */
  incompleteDays(limit: number): SyncDayRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sync_day
         WHERE state != 'complete'
         ORDER BY attendance_date ASC
         LIMIT ?`,
      )
      .all(limit) as SyncDayRow[];
  }

  markDayStaged(date: string, cosecCount: number): void {
    this.db
      .prepare(
        `UPDATE sync_day
         SET state = 'staged', cosec_count = ?, last_fetched_at = ?,
             fetch_attempts = fetch_attempts + 1, last_error = NULL
         WHERE attendance_date = ?`,
      )
      .run(cosecCount, Date.now(), date);
  }

  markDayFetchFailed(date: string, error: string): void {
    this.db
      .prepare(
        `UPDATE sync_day
         SET fetch_attempts = fetch_attempts + 1, last_error = ?
         WHERE attendance_date = ?`,
      )
      .run(error, date);
  }

  markDayPublishing(date: string): void {
    this.db
      .prepare(`UPDATE sync_day SET state = 'publishing' WHERE attendance_date = ?`)
      .run(date);
  }

  /**
   * A day settles once nothing for it is still pending or in flight.
   * Quarantined records keep the day open — they are still being retried — but
   * abandoned ones do not, since those have been reported and given up on.
   */
  settleDay(date: string, stallAfterMs: number): 'complete' | 'stalled' | 'open' {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(state IN ('pending','in_flight','quarantined')) AS open_count,
           SUM(state = 'sent')        AS sent_count,
           SUM(state = 'quarantined') AS quarantined_count
         FROM swipe_event WHERE attendance_date = ?`,
      )
      .get(date) as { open_count: number | null; sent_count: number | null; quarantined_count: number | null };

    const open = counts.open_count ?? 0;
    const now = Date.now();

    this.db
      .prepare(`UPDATE sync_day SET sent_count = ?, quarantined_count = ? WHERE attendance_date = ?`)
      .run(counts.sent_count ?? 0, counts.quarantined_count ?? 0, date);

    if (open === 0) {
      this.db
        .prepare(
          `UPDATE sync_day SET state = 'complete', completed_at = ? WHERE attendance_date = ?`,
        )
        .run(now, date);
      return 'complete';
    }

    const day = this.db
      .prepare(`SELECT created_at FROM sync_day WHERE attendance_date = ?`)
      .get(date) as { created_at: number } | undefined;

    if (day && now - day.created_at > stallAfterMs) {
      this.db.prepare(`UPDATE sync_day SET state = 'stalled' WHERE attendance_date = ?`).run(date);
      return 'stalled';
    }
    return 'open';
  }

  // ---- staging -----------------------------------------------------------

  /**
   * Insert-or-ignore on (terminal_id, unique_id). Re-reading a day COSEC has
   * already given us collapses to a no-op at the database level — no
   * application logic to get wrong. Returns how many rows were genuinely new.
   */
  stageSwipes(rows: StageableSwipe[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO swipe_event
         (attendance_date, terminal_id, unique_id, emp_identification,
          swipe_datetime, payload_json, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (terminal_id, unique_id) DO NOTHING`,
    );
    const now = Date.now();
    let inserted = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const res = stmt.run(
          r.attendanceDate,
          r.terminalId,
          r.uniqueId,
          r.empIdentification,
          r.swipeDateTime,
          r.payloadJson,
          now,
        );
        inserted += res.changes;
      }
    })();
    return inserted;
  }

  // ---- publishing --------------------------------------------------------

  /**
   * Crash recovery. Runs are serialised by a lock file, so anything left
   * in_flight belongs to a run that died — no lease protocol needed.
   *
   * Note these are ambiguous by nature: the batch may have reached ZingHR
   * before the crash. The caller counts them accordingly.
   */
  reclaimInFlight(): number {
    return this.db
      .prepare(
        `UPDATE swipe_event
         SET state = 'pending', ambiguous_count = ambiguous_count + 1
         WHERE state = 'in_flight'`,
      )
      .run().changes;
  }

  claimBatch(limit: number): SwipeEventRow[] {
    const now = Date.now();
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM swipe_event
           WHERE state = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY attendance_date ASC, id ASC
           LIMIT ?`,
        )
        .all(now, limit) as SwipeEventRow[];

      if (rows.length > 0) {
        const marks = this.db.prepare(`UPDATE swipe_event SET state = 'in_flight' WHERE id = ?`);
        for (const r of rows) marks.run(r.id);
      }
      return rows;
    })();
  }

  markSent(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE swipe_event SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`,
    );
    const now = Date.now();
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }

  /**
   * Return records to the queue without blaming them. Used for every
   * batch- and run-scoped failure — an outage is not a property of the payload,
   * so `attempts` is deliberately untouched here.
   */
  releaseUnblamed(ids: number[], error: string, nextAttemptAt: number | null): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE swipe_event
       SET state = 'pending', next_attempt_at = ?, last_error = ?
       WHERE id = ?`,
    );
    this.db.transaction(() => ids.forEach((id) => stmt.run(nextAttemptAt, error, id)))();
  }

  /** As above, but records that the outcome was genuinely unknown (§7). */
  releaseAmbiguous(ids: number[], error: string, nextAttemptAt: number | null): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE swipe_event
       SET state = 'pending', next_attempt_at = ?, last_error = ?,
           ambiguous_count = ambiguous_count + 1
       WHERE id = ?`,
    );
    this.db.transaction(() => ids.forEach((id) => stmt.run(nextAttemptAt, error, id)))();
  }

  /**
   * A rejection naming this specific record. This is the only path that
   * advances `attempts`, and therefore the only path toward abandonment.
   */
  applyOutcomes(outcomes: RecordOutcome[], maxAttempts: number, retryDelayMs: number): void {
    const accept = this.db.prepare(
      `UPDATE swipe_event SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`,
    );
    const quarantine = this.db.prepare(
      `UPDATE swipe_event
       SET state = CASE WHEN attempts + 1 >= ? THEN 'abandoned' ELSE 'quarantined' END,
           attempts = attempts + 1,
           next_attempt_at = ?,
           last_error = ?
       WHERE id = ?`,
    );
    const abandon = this.db.prepare(
      `UPDATE swipe_event
       SET state = 'abandoned', attempts = attempts + 1, last_error = ?
       WHERE id = ?`,
    );

    const now = Date.now();
    this.db.transaction(() => {
      for (const o of outcomes) {
        if (o.accepted) {
          accept.run(now, o.swipeEventId);
        } else if (o.permanent) {
          // Same payload will be rejected identically; no point retrying.
          abandon.run(o.message ?? 'permanent rejection', o.swipeEventId);
        } else {
          quarantine.run(maxAttempts, now + retryDelayMs, o.message ?? 'rejected', o.swipeEventId);
        }
      }
    })();
  }

  /** Quarantined records become eligible again — the new-joiner case. */
  requeueQuarantined(): number {
    return this.db
      .prepare(
        `UPDATE swipe_event
         SET state = 'pending'
         WHERE state = 'quarantined'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .run(Date.now()).changes;
  }

  /**
   * A day previously marked complete can receive new swipes: COSEC records
   * ~23% of them more than a day after the event, so the sweep genuinely finds
   * work for settled dates. Without this the ledger would claim a day is done
   * while rows for it sit pending.
   */
  reopenDaysWithPendingWork(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT attendance_date AS d FROM swipe_event
         WHERE state IN ('pending','in_flight')
           AND attendance_date IN (SELECT attendance_date FROM sync_day WHERE state = 'complete')`,
      )
      .all() as Array<{ d: string }>;
    if (rows.length === 0) return [];
    const stmt = this.db.prepare(
      `UPDATE sync_day SET state = 'publishing', completed_at = NULL WHERE attendance_date = ?`,
    );
    this.db.transaction(() => rows.forEach((r) => stmt.run(r.d)))();
    return rows.map((r) => r.d);
  }

  /** Days holding swipes that are not yet settled, for post-publish bookkeeping. */
  daysWithWork(): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT attendance_date AS d FROM swipe_event ORDER BY d`)
        .all() as Array<{ d: string }>
    ).map((r) => r.d);
  }

  startRun(correlationId: string): number {
    return Number(
      this.db
        .prepare(`INSERT INTO run_log (correlation_id, started_at) VALUES (?, ?)`)
        .run(correlationId, Date.now()).lastInsertRowid,
    );
  }

  finishRun(id: number, outcome: string, s: Record<string, number>, error?: string): void {
    this.db
      .prepare(
        `UPDATE run_log SET finished_at = ?, outcome = ?, days_processed = ?,
           fetched = ?, sent = ?, rejected = ?, ambiguous = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(), outcome, s.days ?? 0, s.fetched ?? 0, s.sent ?? 0,
        s.rejected ?? 0, s.ambiguous ?? 0, error ?? null, id,
      );
  }

  lastSuccessfulRunAt(): number | null {
    const r = this.db
      .prepare(`SELECT MAX(finished_at) AS t FROM run_log WHERE outcome = 'ok'`)
      .get() as { t: number | null };
    return r.t;
  }

  daySummaries(dates: string[]): SyncDayRow[] {
    if (dates.length === 0) return [];
    const marks = dates.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM sync_day WHERE attendance_date IN (${marks}) ORDER BY attendance_date`)
      .all(...dates) as SyncDayRow[];
  }

  /**
   * Delete delivered swipes older than a cutoff, keyed on ATTENDANCE DATE
   * rather than insertion time — the sweep re-reads COSEC by attendance date,
   * so that is the axis on which pruning could collide with it.
   *
   * Only `sent` rows go. Anything pending, quarantined or abandoned is
   * unresolved work and is never pruned regardless of age.
   *
   * SQLite does not shrink the file on delete, but it reuses the freed pages,
   * so the database plateaus at roughly one retention window rather than
   * growing forever. `cli vacuum` reclaims the space if it is ever needed.
   */
  pruneSent(beforeAttendanceDate: string): number {
    // Last line of defence: a malformed cutoff string-compares above every
    // real date and would delete every delivered swipe in the ledger.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeAttendanceDate)) {
      throw new RangeError(`pruneSent: cutoff must be YYYY-MM-DD, got "${beforeAttendanceDate}"`);
    }
    return this.db
      .prepare(`DELETE FROM swipe_event WHERE state = 'sent' AND attendance_date < ?`)
      .run(beforeAttendanceDate).changes;
  }

  pruneRunLog(beforeMs: number): number {
    return this.db.prepare(`DELETE FROM run_log WHERE started_at < ?`).run(beforeMs).changes;
  }

  // ---- reporting ---------------------------------------------------------

  pendingCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM swipe_event WHERE state = 'pending'`).get() as {
        n: number;
      }
    ).n;
  }

  ambiguousRecords(threshold: number): SwipeEventRow[] {
    return this.db
      .prepare(`SELECT * FROM swipe_event WHERE ambiguous_count >= ? ORDER BY ambiguous_count DESC`)
      .all(threshold) as SwipeEventRow[];
  }

  abandoned(since: number): SwipeEventRow[] {
    return this.db
      .prepare(`SELECT * FROM swipe_event WHERE state = 'abandoned' AND created_at >= ?`)
      .all(since) as SwipeEventRow[];
  }

  stalledDays(): SyncDayRow[] {
    return this.db.prepare(`SELECT * FROM sync_day WHERE state = 'stalled'`).all() as SyncDayRow[];
  }
}
