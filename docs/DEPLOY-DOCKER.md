# Deploying with Docker

> **These files have not been built or run.** They were written without a
> Docker daemon available. Treat the first `docker compose build` as the real
> test; the notes below cover what is likely to need adjusting.

## Is Docker the right choice here?

**On Linux: yes, or use systemd — either is easy.**
**On Windows Server: probably not.** It trades one awkward prerequisite for a
heavier one.

| | Windows + NSSM | Windows + Docker | Linux + Docker |
|---|---|---|---|
| Prerequisites | Node MSI | Docker Desktop or Mirantis Engine, plus WSL2/Hyper-V | Docker |
| Licensing | none | **Docker Desktop is paid** for commercial use at >250 staff or >$10M revenue | none |
| On a VM | fine | may need nested virtualisation | fine |
| Server 2016/2019 | fine | WSL2 is 2022+; older needs Hyper-V isolation | n/a |
| `better-sqlite3` native build | **the fragile step** | solved | solved |
| Ask of client IT | install Node + a service | install a container runtime on production | routine |

The genuine Docker win is eliminating the native-module problem — the step
most likely to fail in `DEPLOY-WINDOWS.md`.

## The question worth asking first

**Does this need to run on Windows, or near COSEC, at all?**

The UAT COSEC endpoint is a public IP and ZingHR is public HTTPS, so the
middleware has no LAN dependency: it is a client of two internet-reachable
APIs and holds a local SQLite file. Any small Linux VM will do, and there both
Docker and plain systemd are trivial.

**Confirm production COSEC is also publicly reachable.** If it sits on the
factory LAN, the host must be inside that network and this reasoning does not
apply.

Resource needs are modest: 1 vCPU, 1 GB RAM, and disk for the ledger — roughly
1 GB at the default 180-day retention and ~20k swipes/day.

## Usage

    cp .env.example .env        # fill in; do NOT set DB_PATH/LOCK_PATH,
                                # compose points them at the volume
    docker compose build
    docker compose run --rm sync node dist/cli.js doctor     # check the mapping
    docker compose run --rm sync node dist/main.js --once    # one run
    docker compose up -d                                     # resident, on SCHEDULE

    docker compose logs -f
    docker compose run --rm sync node dist/cli.js status

## Things to get right

**The ledger must be on a volume.** Losing it does not lose data — COSEC is
re-readable — but it loses the record of what was already delivered, so the
next run re-sends the entire sweep window. Duplicates are tolerated by ZingHR,
but it is avoidable noise in a payroll system.

**Timezone.** Containers default to UTC. `SCHEDULE` is interpreted in
`TIMEZONE`, but the system zone still affects `todayIso()` and therefore which
attendance dates get fetched. `TZ` is set in `compose.yaml`; keep it aligned
with `TIMEZONE` in `.env`.

**Signals.** `tini` is the entrypoint so `docker stop` delivers SIGTERM to
Node, letting the scheduler shut down and release the lock. Without it Node
runs as PID 1, ignores SIGTERM by default, and gets SIGKILLed after the grace
period — leaving a stale lock file. (The app clears stale locks on the next
run, so this is untidy rather than dangerous.)

**Log rotation** is configured in `compose.yaml` (10 MB × 5). Without it
container logs grow until the disk fills.

**Backups.** `docker run --rm -v matrix-zinghr-sync_ledger:/data -v $PWD:/out
alpine tar czf /out/ledger.tgz /data`. Worth doing before an upgrade, not for
disaster recovery — the ledger is rebuildable from COSEC.

## Windows-specific, if you go this route anyway

- Docker Desktop must run **Linux containers** (the default), not Windows containers.
- Use a **named volume**, not a bind mount to a Windows path. Bind mounts cross
  the WSL2/host filesystem boundary, where SQLite's locking has known problems.
- Docker Desktop must be set to start at login **and** the machine must
  actually log in after a reboot, or the container never starts. This is a real
  failure mode and precisely what the heartbeat catches.

## Likely first-build issues

| Symptom | Fix |
|---|---|
| `npm ci` fails on `better-sqlite3` | Add `python3 make g++` to the build stage; `node:22-slim` lacks a toolchain if no prebuild matches. |
| `Cannot find module 'better-sqlite3'` at runtime | `node_modules` copied from a different base image; keep both stages on `node:22-slim`. |
| Healthcheck always unhealthy | `cli status` opens the DB — check the volume is writable by uid 1000 (`node`). |
| Runs at the wrong hour | `TZ` in compose disagrees with `TIMEZONE` in `.env`. |
