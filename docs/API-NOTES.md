# ZingHR API — extracted contract

Source: `Swipe Sync - GENERATE TOKEN API 1.docx.pdf`, `Swipe Details Sync API 1.docx.pdf`

## Auth — GET (not POST)

    UAT   https://mservices-uat.zinghr.com/etl/api/v2/Auth/GenerateJWTToken?apiPermission=sswp
    PROD  https://mservices.zinghr.com/etl/api/v2/Auth/GenerateJWTToken?apiPermission=SSWP

HTTP Basic with client key / client secret from 'App Registration'.
Response: `{ Message: string, Code: int, Data: string }` — `Data` is the JWT, `Code: 1` is success.

Failure modes:
- 401 `Authorization header missing.`
- 401 `Invalid client credentials or inactive configuration.` — also fires when the
  App Registration config is deactivated or **has crossed its valid period**
- 400 `Bad apiPermission parameter`
- `Your IP has not been whitelisted to access this resource.` — IP allowlisting
  is a feature of App Registration and may be enabled

## Sync — POST

    UAT   https://mservices-uat.zinghr.com/etl/api/v2/TNA/SynSwipes
    PROD  https://mservices.zinghr.com/etl/api/v2/TNA/SynSwipes

Body property is **`swipes`** (plural). Response `{ Message, Code, Data }`, `Code: 1` = success.

Fields: `empIdentification` (mandatory, max 20), `swipeDateTime` (mandatory,
`yyyy-MM-dd HH:mm:ss`), `terminalId` (optional, max 50), `swipeReceiveDateTime`
(optional, same format), `uniqueId`, `swipeLocation`, `inOutFlag`, `source` (optional).

Documented `Code: 0` messages — note every one is a *batch-level structural*
complaint, none identifies which element failed:

- `SwipeDateTime must be in yyyy-MM-dd HH:mm:ss format`
- `SwipeDateTime is required`
- `EmpIdentification is required`
- `SwipeReceiveDateTime must be in yyyy-MM-dd HH:mm:ss format`
- `Swipes required`
- `Maximum 5000 swipes are allowed at a time`

## OBSERVED vs DOCUMENTED (UAT, 2026-08-26)

The live envelope is **camelCase**, not the PascalCase the PDF specifies, and
carries fields the docs never mention:

    {"code":1,"totalEmployeeCount":null,"svg":0,"data":null,
     "message":"Success","transactionID":null,"lastCachedAt":null,"cachedTill":null}

Parsing therefore lowercases top-level keys before validating, so both shapes
work. Treat the PDF as indicative, not authoritative — everything in it wants
confirming against the live UAT tenant.

`data` is null on success; the failure shape is still unobserved.

**Unknown employee codes are accepted.** A swipe for
`ZZ_NOT_A_REAL_EMPLOYEE_9999` returns `code: 1`. ZingHR performs no
existence check on `empIdentification`.

Scope decision (2026-08-26): this is not the middleware's concern. Our
contract is delivery — every COSEC swipe accepted with `code: 1` — and what
ZingHR does with a code it does not recognise is theirs to own. Consequences:

- Quarantine-and-retry stays in the code but will rarely fire. It existed
  mostly for the new-joiner case, which now cannot be detected.
- Client-side validation is the ONLY content guard. Since ZingHR rejects
  solely on structure, and transform.ts enforces exactly those rules,
  a `code: 0` should be near-impossible in production. Bisection becomes a
  defensive fallback rather than routine machinery.
- Reconciliation reports counts delivered, not employee validity — we have
  no signal for the latter and must not imply one.

## Consequences for the design

1. **`Code`, not HTTP status, decides success.** Exactly the 200-with-failure-body
   case. Never infer delivery from a 2xx.
2. ~~No per-record attribution documented.~~ **The doc is incomplete: `data`
   DOES carry element indices** (`swipes[1].SwipeDateTime`). Verified on UAT;
   see the probe results below. Bisection was demoted to a fallback.
3. **Hard cap 5000 per call.** Batch size is bounded by this. (The "2-minute
   token window" assumed here was wrong — see the probe results below.)
4. **No documented "unknown employee" error.** Every documented validation is
   structural. Either unmapped employees are accepted and orphaned downstream,
   or it is undocumented. MUST be tested on UAT — if such a swipe returns
   `Code: 1`, we would mark it delivered and never learn otherwise.
5. **All documented failures are client-preventable.** Validating format, required
   fields, lengths and batch size before sending makes the entire documented
   error surface unreachable.
6. **No read-back endpoint** in either doc, so an ambiguous send cannot be
   resolved by querying. The §7 policy stands as designed.
7. **IP allowlisting** may be on — the on-prem egress IP must be registered, and
   a NAT/ISP change would present as an auth failure.
8. `apiPermission` case differs between the UAT (`sswp`) and PROD (`SSWP`)
   examples; treat as configuration rather than assuming case-insensitivity.

---

# Matrix COSEC — observed contract (UAT, 2026-08-26)

    http://111.93.87.11:818/cosec/api.svc/v2/template-data
      ?action=get;id=133;date-range=DDMMYYYY-DDMMYYYY;format=json

HTTP Basic. Response: `{"template-data": [ {...}, ... ]}`.

## Query string uses SEMICOLONS, not ampersands

`action=get;id=133;date-range=...;format=json`. `URLSearchParams` would encode
this as a single parameter named `action`, so the query string is assembled by
hand. Do not "fix" it to `&`.

## Record shape

    {"template-id":"133","userid":"2349","username":"HARI ORAON",
     "indexno":"555270","userid1":"2349","username1":"HARI ORAON",
     "indexno1":"555270","eventdatetime":"08/01/2026 05:58:10",
     "eventdatetime1":"08/01/2026 05:58:10","entryexittype":"0",
     "idatetime":"08/06/2026 15:21:34","mastercontrollerid":"2113"}

- `eventdatetime` is **MM/DD/YYYY HH:mm:ss** — ZingHR wants `yyyy-MM-dd HH:mm:ss`,
  so a conversion IS required. The earlier "pass through verbatim" plan was wrong.
  Converted by string rearrangement, never via `Date`, so no timezone can be
  applied to what is already client-local wall-clock time.
- The `*1` columns (`userid1`, `username1`, `indexno1`, `eventdatetime1`) are
  byte-identical to their unsuffixed twins across all 6,824 sampled rows. Ignored.
- `entryexittype`: 0 (98.3%) / 1 (1.7%). Not sent — ZingHR derives direction itself.
- `date-range` filters on `eventdatetime` and is inclusive at both ends.

## `indexno` is a stable, globally unique swipe identifier

Measured over 6,824 rows spanning July + August:

- unique within a fetch, and unique across separate month-long fetches
- **stable across independent overlapping fetches** — 765 shared rows, zero
  identity mismatches
- ordered by `idatetime`, not `eventdatetime`, so it is an insertion sequence
  assigned when COSEC records the event (gaps present; other templates share it)

So `indexno` is the dedupe key. A natural key of
`userid+eventdatetime+mastercontrollerid` would have **silently collapsed 4 of
765 genuinely distinct swipes** in one sampled window, and 6 across August.

## `idatetime` is the receive timestamp — and late arrival is the norm

Measured over 3,906 August rows:

| metric | value |
|---|---|
| `idatetime` earlier than `eventdatetime` | 0 rows (never) |
| median lag | 0.00 h |
| p95 lag | **120.3 h (5.0 days)** |
| max lag | **6.44 days** |
| arriving more than 24h after the swipe | **893 / 3906 = 22.9%** |

**Fetching only "yesterday" would silently miss roughly a quarter of all
swipes.** This is no longer a theoretical concern from the design doc; it is
measured in this tenant's own data. The re-read sweep is mandatory, and
`SWEEP_DAYS` must exceed the observed 6.44-day maximum — set to 10.

Re-reading is cheap (LAN-ish, ~2.5s for 3,906 rows) and sends nothing new,
because `indexno` dedupes at the database level.

## Open

- ~~Which field is ZingHR's employee code?~~ **CONFIRMED 2026-08-27: `userid`.**
  129 distinct values in UAT, max length 12, within ZingHR's 20-char limit.
- No pagination or truncation observed (3,906 rows in a single response). No
  documented cap; the truncation guard stays in as a precaution.

## Security — accepted risk

The endpoint is **plain HTTP on a public IP** with basic auth, so the
credentials cross the internet base64-encoded and readable by anyone on the
path. Raised 2026-08-27; **the endpoint is what it is and cannot be changed.**
Recorded as an accepted risk, not an open action.

What remains on our side, and is done:

- credentials live only in `.env`, which is gitignored; `.env.example` carries
  placeholders
- the logger redacts `password` / `authorization` / `token` paths, so
  credentials cannot reach logs or the daily report
- the ledger stores no COSEC credentials

Worth knowing rather than acting on: an interceptor could read swipe data and
the COSEC credentials in transit. That is the client's risk to carry.

## OBSERVED: the COSEC column set changes under you

Same endpoint, same `id=133`, same `date-range`, roughly one hour apart:

    11:0x  entryexittype, eventdatetime, eventdatetime1, idatetime, indexno,
           indexno1, mastercontrollerid, template-id, userid, userid1,
           username, username1

    12:0x  entryexittype, eventdatetime, idatetime, indexno,
           mastercontrollerid, template-id, userid, username

The four `*1` columns disappeared — someone edited the template in COSEC
between the two calls. Not a theoretical risk: it happened during development,
on the UAT tenant, without notice.

The sync was unaffected, by design:

- the response schema is permissive (unknown columns are ignored, none of the
  vanished columns were depended on)
- every column the mapping does depend on is named in configuration, never
  in code
- `npm run doctor` reports what the endpoint actually returns against what is
  configured

**If a column we DO depend on is renamed**, `toStageable` throws for every row,
the run reports `unmappable rows` in the thousands, and the daily report says
so explicitly — pointing at `COSEC_FIELD_*` / `COSEC_DATETIME_FORMAT`. The day
stays incomplete and retries; nothing is silently dropped or wrongly sent.

Recovery is an .env edit plus `npm run doctor` to confirm, then the next run
picks the day up. No code change, no release.

### Final column set (confirmed 2026-08-27)

    template-id, userid, username, indexno,
    eventdatetime, entryexittype, idatetime, mastercontrollerid

Consistent across all 3,923 rows of a 27-day fetch. The shipped defaults
already match it, so no configuration change was required. Re-validated
against this template:

| assumption | result |
|---|---|
| `indexno` unique | 3923 / 3923 |
| swipes recorded >24h after the event | 22.8% |
| p95 / max arrival lag | 5.00 / 6.44 days |
| `SWEEP_DAYS=10` covers the max lag | yes |
| employee code length vs ZingHR's 20 | max 12 |

---

# ZingHR — probe results (UAT, 2026-08-27)

Four things the PDF got wrong or omitted. Two changed the code.

## 1. Rejections ARE indexed per element

    {"code":0,"message":"Validation Error",
     "data":{"swipes[1].SwipeDateTime":["SwipeDateTime must be in  yyyy-MM-dd HH:mm:ss format"]}}

The `data` keys carry the array index: `swipes[1].SwipeDateTime`. The PDF's
error table lists only bare message strings, which is why bisection was built.

**Bisection is now the fallback, not the primary path.** A rejection is parsed
for `swipes[N]` indices; those records are quarantined and the remainder is
re-sent in one further call — 2 calls instead of ~8, with exact attribution.
Bisection still runs when a rejection carries no index, e.g. `{"swipes":
["Swipes required"]}`, which is batch-scoped rather than element-scoped.

## 2. The batch is atomic

The mixed batch returned **HTTP 400** naming only `swipes[1]`; the two valid
swipes at indices 0 and 2 were not processed. Validation runs before any
insert, so a single bad element rejects the whole array. Hence: quarantine the
named indices, then re-send everything else.

## 3. Validation errors are HTTP 400, and a malformed body is HTTP 500

| request | status | body |
|---|---|---|
| element fails validation | 400 | `code:0`, indexed `data` |
| empty `swipes` array | 400 | `code:0`, `{"swipes":["Swipes required"]}` |
| wrong root key (`swipe`) | **500** | `code:0`, `message:"An unexpected error occurred."`, `data:null` |

A 500 is therefore not proof of a transient fault — it is also what a
structurally wrong request produces. We always send the correct root key, so
treating 5xx as transient stays right, but it is not a safe inference in general.

## 4. The token lives 20 minutes and does NOT invalidate its predecessor

Decoded from the JWT itself: `exp - iat = 1200` seconds. The PDF says "valid
for only few minutes"; the working note said 2 minutes. Both understate it.

Token A was used successfully **after** token B had been issued — `code: 1`.
Issuing a new token does not revoke the old one.

Consequences:

- The "2-minute window" no longer bounds `BATCH_SIZE`. The server's 5000 cap
  and bisection-fallback cost are the real bounds.
- Serial publishing is no longer *required* by token mechanics. It is retained
  because volume is tiny (~150 swipes/day; one batch usually covers a week)
  and concurrency would add complexity for no gain — a deliberate choice now,
  not a constraint.
- Per-POST authentication is retained: at this volume it is typically one extra
  call per run, and it avoids expiry arithmetic and clock-skew entirely.

## COSEC volume and pagination (measured 2026-08-27)

**COSEC does not paginate and does not cap.** A ten-year range returned
157,769 rows in one response. Slices add up exactly — a Jan–Apr query (4,678)
plus a May–Aug query (10,630) equals the combined Jan–Aug query (15,308) — so
nothing is being silently truncated.

Cost of that 157,769-row response, a reasonable proxy for a 10-day sweep at a
production 20k swipes/day:

| stage | time | heap |
|---|---|---|
| download (31 MB) | 9.9 s | — |
| `JSON.parse` | 0.43 s | 152 MB |
| map + validate | 0.19 s | 194 MB |
| stage (insert-or-ignore) | 1.70 s | 196 MB |
| re-stage (dedupe no-op) | 1.07 s | — |

Roughly 200 bytes and 1.2 KB of heap per row.

### Consequence: the sweep fetches one day at a time

Because the whole span arrives in a single all-or-nothing response, a 10-day
sweep at production volume would be one ~40 MB download holding ~250 MB of
heap. Per-day requests instead:

- bound memory to a single day (~20k rows, ~25 MB heap)
- let one failing day fail alone — the other nine still land, and tomorrow's
  sweep covers the same span again
- make progress visible per day in the log

No pagination logic is needed, since each day arrives complete.

### Sizing at ~20k swipes/day (2,000 users)

| | |
|---|---|
| per day | ~20k rows, ~4 MB |
| 10-day sweep | 10 requests, ~200k rows total |
| POSTs per run | ~20 at `BATCH_SIZE=1000` |
| first run against an empty ledger | ~200k staged and sent — expect minutes, not seconds |

`BATCH_SIZE` raised 500 → 1000. Rejections carry element indices, so batch size
no longer drives failure-attribution cost; the remaining reason not to go
straight to the 5000 cap is that a batch-scoped rejection carrying no index
still falls back to bisection.
