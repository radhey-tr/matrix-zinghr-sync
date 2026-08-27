# Deploying on Windows Server

Target: a resident service that runs the sync nightly, restarts on crash, and
starts on boot without anyone logged in.

Nothing here needs a build toolchain **if** the `better-sqlite3` prebuilt
binary matches your Node version — see step 2, which is the step that actually
goes wrong.

---

## 1. Install Node.js 22 LTS (64-bit)

Grab the **MSI** from nodejs.org and install for all users. Then in a new
PowerShell window:

    node --version    # must be v22.x
    npm --version

Node 22 is required for `--env-file`, which is how the service reads its
configuration. Do not install via a user-scoped tool like nvm4w — a Windows
service runs as a different account and will not see it.

## 2. Get the code onto the box and install dependencies

    mkdir C:\services\matrix-zinghr-sync
    cd C:\services\matrix-zinghr-sync
    # copy the repository here, or: git clone <url> .

    npm ci --omit=dev
    npm install --no-save esbuild
    npm run build

**`better-sqlite3` is a native module.** `npm ci` downloads a prebuilt binary
matching your Node version and architecture. If it cannot find one it falls
back to compiling from source, which needs Visual Studio Build Tools and
Python — a long detour.

If the install prints `node-gyp` errors:

    # Option A (preferred): use a Node version with a prebuild available.
    #   Check https://github.com/WiseLibs/better-sqlite3/releases
    # Option B: install the toolchain, once, as Administrator:
    npm install --global windows-build-tools    # legacy but still works
    # or install "Desktop development with C++" from the Visual Studio Installer

Verify the module actually loads before going further:

    node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('create table t(x)'); console.log('sqlite ok')"

## 3. Configuration

Copy `.env.example` to `.env` and fill it in. **Use forward slashes in paths** —
Node accepts them on Windows and it avoids escaping headaches:

    DB_PATH=C:/services/matrix-zinghr-sync/data/sync.db
    LOCK_PATH=C:/services/matrix-zinghr-sync/data/sync.lock

    ENVIRONMENT=production
    ZINGHR_AUTH_URL=https://mservices.zinghr.com/etl/api/v2/Auth/GenerateJWTToken
    ZINGHR_SYNC_URL=https://mservices.zinghr.com/etl/api/v2/TNA/SynSwipes
    ZINGHR_API_PERMISSION=SSWP
    TIMEZONE=Asia/Kolkata
    SCHEDULE=30 0 * * *

Create the data directory and lock the file down — it holds both systems'
credentials:

    mkdir C:\services\matrix-zinghr-sync\data
    icacls .env /inheritance:r
    icacls .env /grant "SYSTEM:(R)" "Administrators:(F)"

Confirm the box's clock and timezone are right. `SCHEDULE` is interpreted in
`TIMEZONE`, but a badly wrong system clock still misfiles attendance dates:

    w32tm /query /status
    Get-TimeZone

## 4. Check it works before making it a service

    npm run doctor          # COSEC shape vs configured mapping
    npm run status          # should report an empty ledger

Then a full dry run, which fetches and stages but never POSTs:

    node --env-file=.env dist/main.js --once

Set `DRY_RUN=true` in `.env` for this. Inspect what would be sent:

    npm run cli pending 10

## 5. Install as a service with NSSM

[NSSM](https://nssm.cc/download) — extract `win64\nssm.exe` somewhere on PATH.
Run these **as Administrator**:

    nssm install MatrixZingHRSync "C:\Program Files\nodejs\node.exe"
    nssm set MatrixZingHRSync AppParameters "--env-file=.env dist\main.js"
    nssm set MatrixZingHRSync AppDirectory "C:\services\matrix-zinghr-sync"
    nssm set MatrixZingHRSync DisplayName "Matrix COSEC to ZingHR swipe sync"
    nssm set MatrixZingHRSync Start SERVICE_AUTO_START

    REM restart on crash, backing off so a crash loop cannot spin
    nssm set MatrixZingHRSync AppExit Default Restart
    nssm set MatrixZingHRSync AppRestartDelay 30000

    REM logs, rotated at 10MB so they cannot fill the disk
    nssm set MatrixZingHRSync AppStdout "C:\services\matrix-zinghr-sync\logs\out.log"
    nssm set MatrixZingHRSync AppStderr "C:\services\matrix-zinghr-sync\logs\err.log"
    nssm set MatrixZingHRSync AppRotateFiles 1
    nssm set MatrixZingHRSync AppRotateBytes 10485760

    mkdir C:\services\matrix-zinghr-sync\logs
    nssm start MatrixZingHRSync
    nssm status MatrixZingHRSync

`AppDirectory` matters: `.env`, `dist/` and the relative paths all resolve from
it.

The service runs as `LocalSystem` by default, which is fine for a local SQLite
file and outbound HTTPS. To use a dedicated account instead:

    nssm set MatrixZingHRSync ObjectName ".\svc_zinghrsync" "<password>"

If you do, grant it **Log on as a service**, give it full control of the
install directory, and be aware that a domain password expiry will silently
stop the service — the heartbeat is what catches that.

## 6. Verify

    nssm status MatrixZingHRSync              # SERVICE_RUNNING
    Get-Content .\logs\out.log -Tail 20

You should see `scheduler.started` and a `scheduler.next` timestamp. The
service now sits idle until `SCHEDULE` fires.

Force a run without waiting for midnight — stop the service first, since the
lock file prevents two runs at once:

    nssm stop MatrixZingHRSync
    node --env-file=.env dist/main.js --once
    nssm start MatrixZingHRSync

---

## Alternative: Task Scheduler instead of a service

Valid, and simpler in some ways — Windows guarantees the invocation, so there
is no resident process to die quietly between runs. The trade is that a task
tied to a user account stops working when that password expires, and the
failure is silent.

    schtasks /create /tn "MatrixZingHRSync" /sc daily /st 00:30 ^
      /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=C:\services\matrix-zinghr-sync\.env C:\services\matrix-zinghr-sync\dist\main.js --once" ^
      /ru "SYSTEM" /rl HIGHEST

`/ru SYSTEM` avoids the password-expiry problem. The app's `--once` mode exits
after one run, and the lock file still prevents overlap if a run outlives its
schedule.

Either way the heartbeat is what tells you the job stopped. **Neither a service
nor a scheduled task reports its own absence.**

---

## Firewall and network

Outbound only. Confirm from the box itself:

    Test-NetConnection 111.93.87.11 -Port 818
    Test-NetConnection mservices.zinghr.com -Port 443

If the site uses an authenticating proxy, set it in `.env`:

    HTTPS_PROXY=http://user:pass@proxy.local:8080
    NO_PROXY=111.93.87.11

Note ZingHR's App Registration may have **IP allowlisting** enabled. If so,
this box's public egress IP must be registered — find it with:

    (Invoke-WebRequest https://api.ipify.org).Content

An un-allowlisted IP presents as a 401, not as a network error, which is easy
to misdiagnose.

## Upgrades

    nssm stop MatrixZingHRSync
    git pull            # or copy the new files in
    npm ci --omit=dev
    npm run build
    nssm start MatrixZingHRSync

The ledger is forward-migrated automatically at startup; migrations are
append-only, so a restart is all that is needed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Service starts then stops immediately | Config invalid. `node --env-file=.env dist/main.js --once` prints the exact field. |
| `Cannot find module 'better-sqlite3'` | `npm ci` skipped or the native build failed. Re-run step 2's verification. |
| `The specified module could not be found` | `better-sqlite3` prebuild does not match this Node version. Reinstall Node 22 LTS or build from source. |
| 401 from ZingHR | Bad credentials, expired App Registration validity period, or this box's IP not allowlisted. |
| Runs but sends nothing | Expected if `DRY_RUN=true`. Check `npm run status`. |
| `another run is active` | A previous run is still going, or a stale lock — the app clears stale locks whose owning process is gone. |
| Nothing happens at 00:30 | Check `TIMEZONE` and the box clock. Logs show `scheduler.next` with the computed time. |
