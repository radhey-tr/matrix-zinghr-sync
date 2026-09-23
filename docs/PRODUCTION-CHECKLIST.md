# Production checklist

Nothing here is optional. Items marked **BLOCKING** will cause silent failure
or data loss if skipped.

## Before the first live run

- [ ] **BLOCKING — `HEARTBEAT_URL`.** Create a dead-man's-switch check
      (healthchecks.io, Cronitor, Better Stack, or self-hosted *somewhere other
      than this box*). With the tail on (default), period 2 min, grace 5 min;
      with `TAIL_SCHEDULE` blank, period 24h, grace 2h. Set `HEARTBEAT_URL` to
      its ping URL.

      Why it is blocking: every other alert runs *inside* the job. If the
      process never runs — box rebooted, service not restarted, scheduler
      disabled, disk full — nothing alerts, and silence is indistinguishable
      from success. The client now expects swipes in ZingHR within minutes;
      this is the only check that notices when they stop arriving.

- [ ] **BLOCKING — measure one tail fetch against production COSEC before
      enabling the 2-minute cadence.** Run `npm run run:tail` with
      `DRY_RUN=true` **and a throwaway `DB_PATH`** late in a working day —
      the last ticks of the day re-read the most rows, so that is the worst
      case and the only one worth measuring. Read `ms` from the
      `tail.fetched` log line.

      At 2-minute ticks COSEC runs that report query ~720 times a day; UAT
      took ~2.5 s for 3,906 rows, but production is ~5× the volume on a box
      that also runs door control. Divide the measured `ms` by the interval
      to get the share of the day COSEC spends serving this integration:
      10 s of a 120 s tick is 8%, 30 s is 25%. Past roughly 30 s, move
      `TAIL_SCHEDULE` to `*/5` — the same fetch is then 10%, and one extra
      interval costs the client ~90 seconds of freshness they cannot
      perceive.

      The throwaway `DB_PATH` matters: a dry run still stages what it reads,
      and those rows stay `pending` for the first live run to deliver.
- [ ] **Ask ZingHR whether the sync endpoint is rate-limited.** The tail makes
      up to ~720 token + POST pairs a day instead of ~20. Nothing observed on
      UAT suggests a limit, but nobody has asked.
- [ ] Tell the client what "realtime" means: about a minute after COSEC
      records the swipe. Swipes from offline or batch-synced readers reach
      COSEC late — sometimes days — and no sync cadence changes that; they
      arrive via the nightly sweep. Set this expectation before go-live, not
      after the first "missing punch" ticket.
- [ ] After two weeks live, re-measure arrival lag on production data
      (`eventdatetime` vs `idatetime`). The UAT figures come from a
      commissioning-period dataset and overstate lateness, so they are a
      ceiling rather than a baseline. `SWEEP_DAYS` and `RETENTION_DAYS` are
      sized against them and can only be relaxed once real numbers exist.

- [ ] Switch both URLs to production hosts (`mservices.zinghr.com`).
- [ ] Set `ZINGHR_API_PERMISSION=SSWP` — the prod doc shows uppercase, UAT lowercase.
- [ ] Obtain the production App Registration client key and secret.
- [ ] **Confirm whether IP allowlisting is enabled** on the App Registration.
      If so, register this host's egress IP. Presents as a 401, not as a
      network error, so it is easy to misdiagnose under pressure.
- [ ] Record the App Registration's **validity period end date** somewhere a
      human will see it. When it lapses the integration stops with an auth
      error and no other warning.
- [ ] `ALERT_WEBHOOK_URL` pointed at a channel people read.
- [ ] `ENVIRONMENT=production`.
- [ ] Confirm outbound access to both COSEC and `mservices.zinghr.com`,
      including any authenticating proxy.

## Sizing (measured, ~20k swipes/day at 2,000 users)

- [ ] Disk: the ledger plateaus at roughly one retention window.
      `RETENTION_DAYS=180` ≈ **1 GB**. Budget 2 GB and monitor free space.
- [ ] `RETENTION_DAYS` must exceed `SWEEP_DAYS * 3 + 7`. Enforced at boot —
      pruning inside the sweep window would re-stage and re-send delivered
      swipes as duplicates in payroll.
- [ ] `BATCH_SIZE=1000` gives ~20 POSTs per run. Server cap is 5000.
- [ ] First live run against an empty ledger stages and sends the whole sweep
      window (~200k swipes). Expect minutes. If you only want yesterday,
      `rm sync.db` after any shadow run.

## Deployment

- [ ] Supervisor with restart-on-exit: systemd, or NSSM if the host is Windows.
- [ ] Run as a non-privileged user; `.env` readable only by it (`chmod 600`).
- [ ] Verify `sync.db` lives on persistent storage, not a temp filesystem.

## Shadow run

- [ ] `DRY_RUN=true` against production COSEC for one full pay cycle.
- [ ] Compare the daily report against whatever process exists today.
- [ ] `rm sync.db` before going live, or the accumulated backlog flushes on
      the first live run.

## Accepted risks

- COSEC is plain HTTP on a public IP with basic auth. Raised 2026-08-27; the
  endpoint cannot be changed. Credentials stay in gitignored `.env` and the
  logger redacts them, but they are readable in transit.
- ZingHR accepts swipes for employee codes that do not exist (`code: 1`), so
  an unmapped employee is undetectable here. Delivery is this system's
  contract; employee validity is not.
