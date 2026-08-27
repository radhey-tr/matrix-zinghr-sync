#!/usr/bin/env bash
# ZingHR UAT probe — the four contract questions still unanswered.
#
# Earlier probing already settled: the auth envelope is camelCase, success is
# `code: 1` in the body, and unknown employee codes are accepted. Those tests
# have been removed; what remains is what could still change the code.
#
#   export ZING_USER='<client key from App Registration>'
#   export ZING_PASS='<client secret>'
#   export ZING_EMP='2127'          # a real COSEC userid
#   ./scripts/uat-probe.sh
#
# WRITES REAL SWIPES into the UAT tenant. Probe 3 writes ~600 rows to time a
# realistic batch. Skip it with SKIP_VOLUME=1 if others are using the tenant.

set -uo pipefail

AUTH="https://mservices-uat.zinghr.com/etl/api/v2/Auth/GenerateJWTToken?apiPermission=sswp"
SYNC="https://mservices-uat.zinghr.com/etl/api/v2/TNA/SynSwipes"
OUT="uat-results"

: "${ZING_USER:?set ZING_USER}"; : "${ZING_PASS:?set ZING_PASS}"; : "${ZING_EMP:?set ZING_EMP}"
mkdir -p "$OUT"
TS=$(date +%Y-%m-%d)

token() {
  curl -sS -u "$ZING_USER:$ZING_PASS" -H 'Accept: application/json' "$AUTH" \
    | jq -r '.data // .Data // empty'
}
swipe() { printf '{"empIdentification":"%s","swipeDateTime":"%s"}' "$1" "$2"; }

probe() {
  local name=$1 body=$2 tok status
  tok=$(token)
  [[ -z "$tok" ]] && { echo "  !! no token"; return 1; }
  status=$(curl -sS -o "$OUT/$name.json" -w '%{http_code}' -X POST "$SYNC" \
    -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
    -H 'Accept: application/json' --data "$body")
  echo "  HTTP $status | code=$(jq -r '.code // .Code // "ABSENT"' "$OUT/$name.json")"
  echo "  $(head -c 500 "$OUT/$name.json")"
  echo
}

echo "############################################################"
echo " 1. MIXED BATCH — does the response say WHICH element failed?"
echo "    indices present -> bisection in src/bisect.ts is dead code"
echo "    no indices      -> bisection stays (as currently built)"
echo "    Also: are the 2 valid swipes accepted, or is the batch atomic?"
echo "############################################################"
probe "p1-mixed" "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 10:00:00"),{\"empIdentification\":\"$ZING_EMP\",\"swipeDateTime\":\"BADFORMAT\"},$(swipe "$ZING_EMP" "$TS 10:02:00")]}"

echo "############################################################"
echo " 2. ERROR SHAPES — what does 'data' actually contain on code 0?"
echo "    src/zinghr.ts messagesFrom() flattens this into the report."
echo "############################################################"
probe "p2a-missing-emp" "{\"swipes\":[{\"swipeDateTime\":\"$TS 12:00:00\"}]}"
probe "p2b-missing-dt"  "{\"swipes\":[{\"empIdentification\":\"$ZING_EMP\"}]}"
probe "p2c-bad-dt"      "{\"swipes\":[$(swipe "$ZING_EMP" "${TS}T12:00:00")]}"
probe "p2d-empty"       '{"swipes":[]}'
probe "p2e-wrong-key"   "{\"swipe\":[$(swipe "$ZING_EMP" "$TS 12:30:00")]}"

echo "############################################################"
echo " 3. BATCH TIMING — sets BATCH_SIZE against the ~2 min token."
echo "    A POST must START within 2 minutes of its auth call."
echo "############################################################"
if [[ "${SKIP_VOLUME:-0}" == "1" ]]; then
  echo "  skipped (SKIP_VOLUME=1)"
else
  gen() { local n=$1 out="" i; for ((i=0;i<n;i++)); do
    [[ -n "$out" ]] && out+=","
    out+=$(swipe "$ZING_EMP" "$TS $(printf '%02d:%02d:%02d' $((i/3600%24)) $((i/60%60)) $((i%60)))")
  done; printf '{"swipes":[%s]}' "$out"; }
  for n in 100 500; do
    start=$(date +%s); echo "  --- $n swipes ---"
    probe "p3-batch-$n" "$(gen $n)"
    echo "  elapsed $(( $(date +%s) - start ))s (must stay well under 120s)"
  done
fi

echo "############################################################"
echo " 4. TOKEN INVALIDATION — does issuing token B kill token A?"
echo "    If yes, serial publishing is load-bearing, not merely tidy."
echo "############################################################"
A=$(token); sleep 1; B=$(token)
[[ "$A" == "$B" ]] && echo "  NOTE: identical tokens returned (no rotation)"
curl -sS -o "$OUT/p4-old-token.json" -w '  token A after issuing B -> HTTP %{http_code}\n' \
  -X POST "$SYNC" -H "Authorization: Bearer $A" -H 'Content-Type: application/json' \
  --data "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 13:00:00")]}"
echo "  $(head -c 300 "$OUT/p4-old-token.json")"

python3 -c "
import sys,base64,json
t='$A'.strip()
if t.count('.')==2:
    p=t.split('.')[1]; p+='='*(-len(p)%4)
    c=json.loads(base64.urlsafe_b64decode(p))
    if 'exp' in c and 'iat' in c: print(f\"  actual token TTL: {c['exp']-c['iat']}s\")
" 2>/dev/null

echo
echo "Responses in $OUT/ — paste them back to wire the parser to reality."
