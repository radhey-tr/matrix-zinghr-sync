# Production checklist

Nothing here is optional. Items marked **BLOCKING** will cause silent failure
or data loss if skipped.

## Before the first live run

- [ ] **BLOCKING — `HEARTBEAT_URL`.** Create a dead-man's-switch check
      (healthchecks.io, Cronitor, Better Stack, or self-hosted *somewhere other
      than this box*), period 24h, grace 2h. Set `HEARTBEAT_URL` to its ping URL.

      Why it is blocking: every other alert runs *inside* the nightly job. If
      the job never runs — box rebooted, service not restarted, scheduler
      disabled, disk full — nothing alerts, and silence is indistinguishable
      from success. At one run a night on a monthly payroll cycle that can go
      unnoticed for weeks. This is the only check that catches it.

- [ ] Switch both URLs to production hosts (`mservices.zinghr.com`).
- [ ] Set `ZINGHR_API_PERMISSION=SSWP` — the prod doc shows uppercase, UAT lowercase.
- [ ] Obtain the production App Registration client key and secret.
- [ ] **Confirm whether IP allowlisting is enabled** on the App Registration.
      If so, register this host's egress IP. Presents as a 401, not as a
      network error, so it is easy to misdiagnose under pressure.
- [ ] Record the App Registration's **validity period end date** somewhere a
      human will see it. When it lapses the integration stops with an auth
      error and no other warning.
- [ ] `ALERT_WEBHOOK_URL` / `REPORT_EMAIL_TO` pointed somewhere people read.
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
