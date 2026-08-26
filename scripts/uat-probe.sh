#!/usr/bin/env bash
# ZingHR UAT probe battery.
#
# Answers the open contract questions before we write the publisher against
# guesses. Every response is saved to uat-results/ so the parser can be built
# from evidence rather than from the PDF's prose.
#
#   export ZING_USER='<client key>'
#   export ZING_PASS='<client secret>'
#   export ZING_EMP='<a REAL employee code in the UAT tenant>'
#   ./scripts/uat-probe.sh
#
# Add SLOW=1 to include the two tests that need a ~2 minute wait.

set -uo pipefail

AUTH="https://mservices-uat.zinghr.com/etl/api/v2/Auth/GenerateJWTToken?apiPermission=sswp"
SYNC="https://mservices-uat.zinghr.com/etl/api/v2/TNA/SynSwipes"
OUT="uat-results"

: "${ZING_USER:?set ZING_USER}" ; : "${ZING_PASS:?set ZING_PASS}"
: "${ZING_EMP:?set ZING_EMP to a real UAT employee code}"

mkdir -p "$OUT"
TS=$(date +%Y-%m-%d)
pretty() { command -v jq >/dev/null && jq . 2>/dev/null || cat; }

token() {
  curl -sS -u "$ZING_USER:$ZING_PASS" -H 'Accept: application/json' "$AUTH" \
    | { command -v jq >/dev/null && jq -r '.Data // empty' || sed -n 's/.*"Data":"\([^"]*\)".*/\1/p'; }
}

# $1 = test name, $2 = JSON body
probe() {
  local name=$1 body=$2 tok status
  tok=$(token)
  if [[ -z "$tok" ]]; then echo "  !! could not obtain token"; return 1; fi

  status=$(curl -sS -o "$OUT/$name.json" -w '%{http_code}' \
    -X POST "$SYNC" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    --data "$body")

  echo "  HTTP $status"
  echo -n "  Code: "
  if command -v jq >/dev/null; then jq -r '.Code // "ABSENT"' "$OUT/$name.json"; else grep -o '"Code":[0-9]*' "$OUT/$name.json"; fi
  echo "  body: $(head -c 400 "$OUT/$name.json")"
  echo
}

swipe() { printf '{"empIdentification":"%s","swipeDateTime":"%s"}' "$1" "$2"; }

echo "=============================================================="
echo " 1. AUTH — envelope shape, and is Data really the raw JWT?"
echo "=============================================================="
curl -sS -i -u "$ZING_USER:$ZING_PASS" -H 'Accept: application/json' "$AUTH" \
  | tee "$OUT/01-auth.txt" | head -30
echo

echo "=============================================================="
echo " 2. AUTH with bad credentials — expect 401, note the shape"
echo "=============================================================="
curl -sS -o "$OUT/02-auth-bad.json" -w '  HTTP %{http_code}\n' \
  -u "definitely:wrong" -H 'Accept: application/json' "$AUTH"
head -c 300 "$OUT/02-auth-bad.json"; echo; echo

echo "=============================================================="
echo " 3. AUTH with no apiPermission — expect 400"
echo "=============================================================="
curl -sS -o "$OUT/03-auth-noperm.json" -w '  HTTP %{http_code}\n' \
  -u "$ZING_USER:$ZING_PASS" -H 'Accept: application/json' \
  "https://mservices-uat.zinghr.com/etl/api/v2/Auth/GenerateJWTToken"
head -c 300 "$OUT/03-auth-noperm.json"; echo; echo

echo "=============================================================="
echo " 4. HAPPY PATH — one valid swipe. Baseline for everything else."
echo "=============================================================="
probe "04-happy" "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 09:15:00")]}"

echo "=============================================================="
echo " 5. *** UNKNOWN EMPLOYEE — the critical unknown ***"
echo "    Code 0 -> quarantine-and-retry works as designed."
echo "    Code 1 -> the swipe is silently orphaned and we can NEVER"
echo "              detect it. That would change the design."
echo "=============================================================="
probe "05-unknown-emp" "{\"swipes\":[$(swipe "ZZNOTREAL999" "$TS 09:16:00")]}"

echo "=============================================================="
echo " 6. *** MIXED BATCH — does Data identify WHICH element failed? ***"
echo "    Indices present -> bisection is unnecessary, publisher simplifies."
echo "    No indices      -> bisection is mandatory (as currently built)."
echo "    Also: are the 2 good swipes accepted, or is the batch atomic?"
echo "=============================================================="
probe "06-mixed" "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 10:00:00"),{\"empIdentification\":\"$ZING_EMP\",\"swipeDateTime\":\"BADFORMAT\"},$(swipe "$ZING_EMP" "$TS 10:02:00")]}"

echo "=============================================================="
echo " 7. DUPLICATE — same swipe twice. Confirms 'duplicates are fine'"
echo "    at the API level (payroll output still needs eyeballing)."
echo "=============================================================="
probe "07-dupe-a" "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 11:11:11")]}"
probe "07-dupe-b" "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 11:11:11")]}"

echo "=============================================================="
echo " 8. DOCUMENTED VALIDATION ERRORS — capture exact Data shapes"
echo "=============================================================="
probe "08a-missing-emp"  "{\"swipes\":[{\"swipeDateTime\":\"$TS 12:00:00\"}]}"
probe "08b-missing-dt"   "{\"swipes\":[{\"empIdentification\":\"$ZING_EMP\"}]}"
probe "08c-bad-dt"       "{\"swipes\":[$(swipe "$ZING_EMP" "$TS""T12:00:00")]}"
probe "08d-empty-array"  '{"swipes":[]}'
probe "08e-wrong-key"    "{\"swipe\":[$(swipe "$ZING_EMP" "$TS 12:30:00")]}"
probe "08f-long-emp"     "{\"swipes\":[$(swipe "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" "$TS 12:40:00")]}"

echo "=============================================================="
echo " 9. BATCH CAP — 5001 swipes should be refused; time 500 & 2000"
echo "    to size BATCH_SIZE against the 2-minute token window."
echo "=============================================================="
gen() { local n=$1 out="" i; for ((i=0;i<n;i++)); do
  [[ -n "$out" ]] && out+=","
  out+=$(swipe "$ZING_EMP" "$TS $(printf '%02d:%02d:%02d' $((i/3600%24)) $((i/60%60)) $((i%60)))")
done; printf '{"swipes":[%s]}' "$out"; }

for n in 500 2000; do
  echo "  --- $n swipes ---"
  body=$(gen "$n"); start=$(date +%s)
  probe "09-batch-$n" "$body"
  echo "  elapsed: $(( $(date +%s) - start ))s  (must stay well under 120s)"
done
echo "  --- 5001 swipes (expect the cap message) ---"
probe "09-batch-5001" "$(gen 5001)"

echo "=============================================================="
echo "10. TOKEN REUSE — does issuing token B invalidate token A?"
echo "    If A now 401s, single-flight/serial publishing is mandatory."
echo "=============================================================="
A=$(token); sleep 1; B=$(token)
[[ "$A" == "$B" ]] && echo "  NOTE: identical tokens returned"
curl -sS -o "$OUT/10-old-token.json" -w '  token A after issuing B -> HTTP %{http_code}\n' \
  -X POST "$SYNC" -H "Authorization: Bearer $A" -H 'Content-Type: application/json' \
  --data "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 13:00:00")]}"
head -c 200 "$OUT/10-old-token.json"; echo; echo

if [[ "${SLOW:-0}" == "1" ]]; then
  echo "=============================================================="
  echo "11. TOKEN EXPIRY — how long is it really valid? (~2 min wait)"
  echo "=============================================================="
  T=$(token)
  for w in 60 120 180; do
    sleep $(( w == 60 ? 60 : 60 ))
    curl -sS -o /dev/null -w "  after ${w}s -> HTTP %{http_code}\n" \
      -X POST "$SYNC" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
      --data "{\"swipes\":[$(swipe "$ZING_EMP" "$TS 14:00:00")]}"
  done
fi

echo "Responses saved to $OUT/"
