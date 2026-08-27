# matrix-zinghr-sync

Nightly sync of biometric swipe data from **Matrix COSEC** to **ZingHR** payroll.

One day's swipes per night, each delivered exactly once. Recovery comes from a
ledger that remembers what succeeded rather than from re-sending, so nothing
lands in ZingHR twice unless the network genuinely left us unsure.

Design rationale: [`design-plan.html`](design-plan.html) ·
Observed API behaviour: [`docs/API-NOTES.md`](docs/API-NOTES.md)

## Quick start

    npm install
    cp .env.example .env        # fill in credentials
    npm run doctor              # check the COSEC mapping against live data
    DRY_RUN=true npm run run:once
    npm start                   # resident process, runs on SCHEDULE

## How a run works

    reclaim   rows left in_flight by a run that died (counted as ambiguous)
    requeue   quarantined swipes get another attempt
    stage     fetch each incomplete day, oldest first, into the ledger
    sweep     RE-READ the last SWEEP_DAYS from COSEC
    reopen    a settled day the sweep found new swipes for
    publish   drain to ZingHR, serially, one fresh token per POST
    settle    mark days complete, or stalled if open too long

The sweep is load-bearing, not belt-and-braces. Measured on this tenant's own
data, **22.9% of swipes are recorded by COSEC more than 24 hours after the
event** (p95 lag 5.0 days, max 6.44). Fetching only "yesterday" would silently
miss about a quarter of everything. Re-reading is cheap and sends nothing new,
because the identity column dedupes at the database level.

## Operations

    npm run status              ledger at a glance
    npm run doctor [date]       COSEC shape vs configured mapping
    npm run cli day 2026-08-25  detail for one date
    npm run cli reopen <date>   re-fetch a settled day (sends only new rows)
    npm run cli replay          return quarantined/abandoned swipes to the queue
    npm run cli pending [n]     payloads that would go next

## When COSEC's fields change

They do — the column set changed once during development, unannounced. Nothing
about COSEC's shape is compiled in:

| Variable | Meaning |
|---|---|
| `COSEC_RESPONSE_KEY` | JSON property wrapping the rows |
| `COSEC_FIELD_EMP` | column holding ZingHR's employee code |
| `COSEC_FIELD_DATETIME` | column holding the swipe timestamp |
| `COSEC_FIELD_UNIQUE` | stable per-swipe identity — the dedupe key |
| `COSEC_FIELD_TERMINAL` | reader identity (optional) |
| `COSEC_DATETIME_FORMAT` | e.g. `MM/DD/YYYY HH:mm:ss` |

Run `npm run doctor` — it prints the columns actually returned, checks each
configured field, verifies the identity column really is unique, and shows one
row raw and mapped. Edit `.env`, re-run, done.

`COSEC_DATETIME_FORMAT` is explicit for a reason: `03/08/2026` is March 8th
under `MM/DD` and August 3rd under `DD/MM`. Guessing wrong shifts attendance by
months with no error anywhere.

## Dry run vs live

`DRY_RUN` controls one thing: whether the publisher is invoked.

|  | `DRY_RUN=true` | `DRY_RUN=false` |
|---|---|---|
| Fetch COSEC | yes | yes |
| Map + validate rows | yes | yes |
| Write to the local ledger | yes | yes |
| Call ZingHR | **never** | yes |
| Swipes end as | `pending` | `sent` |

So a dry run exercises everything except delivery, and is safe to point at
production COSEC. It still writes the ledger, which is the point: you can
inspect exactly what would have been sent with `npm run cli pending`.

**Swipes staged during a dry run are not discarded.** They stay `pending`, so
the first live run afterwards delivers the whole accumulated backlog at once.
That is usually what you want after a shadow run — but if you dry-ran for a
fortnight and only want yesterday, clear the ledger (`rm sync.db`) before
going live.

## Behaviour worth knowing

- **Success is `code: 1` in the response body, not the HTTP status.** ZingHR
  returns 200 with `code: 0` for rejections.
- **Unknown employee codes are accepted** (`code: 1`). ZingHR performs no
  existence check. Delivery is this system's contract; employee validity is not
  detectable here.
- **Publishing is strictly serial.** Issuing a ZingHR token invalidates the
  previous one, so concurrent batches would void each other's credentials.
- **A ZingHR outage never blames the payload.** Batch- and run-scoped failures
  return swipes to the queue with their attempt count untouched; only a
  rejection naming a specific swipe advances it toward abandonment.
- **Ambiguous sends retry once, then wait for tomorrow.** A timeout after the
  request was sent leaves the outcome unknown; each extra retry can mint
  another duplicate.

## Deployment

Long-running process under a supervisor with restart-on-exit — systemd, or a
Windows service via NSSM. Needs outbound access to COSEC and to
`mservices*.zinghr.com`. ZingHR App Registration may have IP allowlisting
enabled, so the egress IP must be registered.

Set `HEARTBEAT_URL` to an external dead-man's-switch. A nightly job can be dead
for a fortnight before anyone notices, and internal monitoring cannot report
its own death.

## Tests

    npm test          # 74 tests
    npm run typecheck
