-- Which cadence produced a run. The nightly does the sweep, settle and prune;
-- the tail only fetches today and publishes. Health checks need to tell them
-- apart: "no successful tail in an hour" and "no successful nightly in a day"
-- are different alerts.
ALTER TABLE run_log ADD COLUMN mode TEXT NOT NULL DEFAULT 'nightly';
