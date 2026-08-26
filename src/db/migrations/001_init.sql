-- One row per attendance date. Answers: has this day been fully delivered?
CREATE TABLE sync_day (
  attendance_date    TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  state              TEXT NOT NULL DEFAULT 'pending',
  fetch_attempts     INTEGER NOT NULL DEFAULT 0,
  last_fetched_at    INTEGER,
  cosec_count        INTEGER,                   -- rows COSEC reported
  sent_count         INTEGER NOT NULL DEFAULT 0,
  quarantined_count  INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  CHECK (state IN ('pending','staged','publishing','complete','stalled'))
);

-- One row per swipe. Answers: has this individual swipe been delivered?
CREATE TABLE swipe_event (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  attendance_date     TEXT NOT NULL REFERENCES sync_day(attendance_date),
  terminal_id         TEXT NOT NULL,
  unique_id           TEXT NOT NULL,
  emp_identification  TEXT NOT NULL,
  swipe_datetime      TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending',

  -- Record-scoped failures ONLY. An outage must never advance this, or a day
  -- of good swipes marches into 'abandoned' during someone else's incident.
  attempts            INTEGER NOT NULL DEFAULT 0,

  -- Sends whose outcome could not be determined. Tracked separately precisely
  -- so it does NOT push a blameless record toward abandonment.
  ambiguous_count     INTEGER NOT NULL DEFAULT 0,

  next_attempt_at     INTEGER,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER,

  -- The dedupe backbone: makes re-reading a day from COSEC a no-op, which is
  -- what lets us re-read freely while sending only what is genuinely new.
  UNIQUE (terminal_id, unique_id),
  CHECK (state IN ('pending','in_flight','sent','quarantined','abandoned'))
);

CREATE INDEX idx_swipe_dispatch ON swipe_event (state, next_attempt_at);
CREATE INDEX idx_swipe_day      ON swipe_event (attendance_date, state);
CREATE INDEX idx_swipe_emp      ON swipe_event (emp_identification, swipe_datetime);

CREATE TABLE run_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id  TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  outcome         TEXT,
  days_processed  INTEGER NOT NULL DEFAULT 0,
  fetched         INTEGER NOT NULL DEFAULT 0,
  sent            INTEGER NOT NULL DEFAULT 0,
  rejected        INTEGER NOT NULL DEFAULT 0,
  ambiguous       INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
