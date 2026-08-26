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
2. **No per-record attribution documented.** `Data` is "all the validation
   messages" with no element index. Bisection is therefore mandatory, not a
   fallback. VERIFY on UAT — `Data` may carry indices the doc does not mention.
3. **Hard cap 5000 per call.** Batch size is bounded by this AND by the 2-minute
   token window; smaller batches also make bisection cheaper.
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
