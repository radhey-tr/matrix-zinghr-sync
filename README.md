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
    npm run build               # bundles to dist/, no experimental flags
    npm run doctor              # check the COSEC mapping against live data
    npm run run:once            # one run (set DRY_RUN=true first)
    npm start                   # resident process, runs on SCHEDULE

Configuration is read from `.env` by Node's own `--env-file`, so there is no
dotenv dependency and the service needs no wrapper script to set variables.

For development against the TypeScript sources directly, `npm run dev:once`
and `npm run dev:cli` use `.env.local`.

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
- **Publishing is serial by choice.** Tokens do not revoke one another (UAT
  confirms), so concurrency would be safe — but one batch usually covers a
  week, so it would add moving parts for nothing.
- **A ZingHR outage never blames the payload.** Batch- and run-scoped failures
  return swipes to the queue with their attempt count untouched; only a
  rejection naming a specific swipe advances it toward abandonment.
- **Ambiguous sends retry once, then wait for tomorrow.** A timeout after the
  request was sent leaves the outcome unknown; each extra retry can mint
  another duplicate.

## Deployment

**Windows Server: [`docs/DEPLOY-WINDOWS.md`](docs/DEPLOY-WINDOWS.md)** — full
walkthrough including the `better-sqlite3` native-module trap, NSSM service
setup, and a Task Scheduler alternative.

**Before going live: [`docs/PRODUCTION-CHECKLIST.md`](docs/PRODUCTION-CHECKLIST.md).**

In short: a long-running process under a supervisor with restart-on-exit —
systemd, or NSSM on Windows. Outbound access to COSEC and
`mservices.zinghr.com`. ZingHR's App Registration may have IP allowlisting, in
which case the egress IP must be registered.

Set `HEARTBEAT_URL` to an external dead-man's-switch. A nightly job can be dead
for a fortnight before anyone notices, and internal monitoring cannot report
its own death.

`npm run build` produces `dist/` (~53 KB). Runtime dependencies stay external,
so `node_modules` ships alongside — unavoidable regardless, since
`better-sqlite3` is a native module.

## Disk

Measured at ~20k swipes/day: **~330 bytes per swipe**, so ~6 MB/day.

| retention | steady-state ledger |
|---|---|
| 30 days | ~180 MB |
| 180 days (default) | ~1 GB |
| 365 days | ~2.1 GB |

Delivered swipes past `RETENTION_DAYS` are pruned at the end of each run.
Anything unresolved — pending, quarantined, abandoned — is never pruned
regardless of age. SQLite reuses freed pages, so the file plateaus rather than
growing; `npm run cli vacuum` reclaims space on disk if it is ever needed.

`RETENTION_DAYS` must exceed `SWEEP_DAYS * 3 + 7`, enforced at boot. Pruning a
delivered swipe still inside the sweep window would let it be re-read,
re-staged and re-sent — a duplicate in payroll, from a config typo.

## Tests

    npm test          # 74 tests
    npm run typecheck
