#!/bin/sh
# Verify the gym-sync endpoint behaves as intended.
#   check-webdav.sh BASE_URL [USER [PASSWORD]]
# e.g. check-webdav.sh https://pasky.or.cz/gym-sync gym 'secret'
# Without a password only the unauthenticated checks run. The authenticated checks write
# and read back selftest.json; they can't delete it (DELETE is denied), so remove it yourself.
set -u
BASE=${1:?usage: $0 BASE_URL [USER [PASSWORD]]}
USER=${2:-gym}
PASS=${3:-}
fail=0

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { # expect "description" "allowed codes (space separated)" actual
	case " $2 " in
		*" $3 "*) echo "ok    $1 -> $3" ;;
		*) echo "FAIL  $1 -> $3 (expected $2)"; fail=1 ;;
	esac
}

echo "== unauthenticated"
expect "GET state.json"            "401"     "$(code "$BASE/state.json")"
expect "GET directory"             "401"     "$(code "$BASE/")"
expect "PUT"                       "401 403" "$(code -X PUT --data '{}' "$BASE/x.json")"
expect "PROPFIND"                  "401 403" "$(code -X PROPFIND -H 'Depth: 1' "$BASE/")"
expect "OPTIONS"                   "401 403" "$(code -X OPTIONS "$BASE/")"
expect "wrong password"            "401"     "$(code -u "$USER:wrong-password" "$BASE/state.json")"

if [ -n "$PASS" ]; then
	A="$USER:$PASS"
	body="{\"selftest\":$(date +%s)}"
	echo "== authenticated"
	expect "PUT selftest.json"         "201 204" "$(code -u "$A" -X PUT -H 'Content-Type: application/json' --data "$body" "$BASE/selftest.json")"
	got=$(curl -s -u "$A" "$BASE/selftest.json")
	if [ "$got" = "$body" ]; then echo "ok    GET returns what was PUT"; else echo "FAIL  GET returned: $got"; fail=1; fi
	hdrs=$(curl -s -D - -o /dev/null -u "$A" "$BASE/selftest.json" | tr -d '\r')
	echo "$hdrs" | grep -qi '^content-type: application/json' && echo "ok    Content-Type json" || { echo "FAIL  Content-Type"; fail=1; }
	echo "$hdrs" | grep -qi '^cache-control: no-store' && echo "ok    Cache-Control no-store" || { echo "FAIL  Cache-Control"; fail=1; }
	expect "PUT overwrite"             "204 201" "$(code -u "$A" -X PUT --data "$body" "$BASE/selftest.json")"
	expect "GET directory listing"     "403 404" "$(code -u "$A" "$BASE/")"
	expect "PROPFIND"                  "403"     "$(code -u "$A" -X PROPFIND -H 'Depth: 1' "$BASE/")"
	expect "DELETE"                    "403"     "$(code -u "$A" -X DELETE "$BASE/selftest.json")"
	expect "MKCOL"                     "403"     "$(code -u "$A" -X MKCOL "$BASE/sub/")"
	expect "MOVE"                      "403"     "$(code -u "$A" -X MOVE -H "Destination: $BASE/moved.json" "$BASE/selftest.json")"
	expect "COPY"                      "403"     "$(code -u "$A" -X COPY -H "Destination: $BASE/copied.json" "$BASE/selftest.json")"
	expect "LOCK"                      "403"     "$(code -u "$A" -X LOCK "$BASE/selftest.json")"
	expect "PUT into subdirectory"     "403 404 409" "$(code -u "$A" -X PUT --data '{}' "$BASE/sub/x.json")"
	expect "PUT too large (6 MB)"      "413"     "$(head -c 6000000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -u "$A" -X PUT --data-binary @- "$BASE/big.json")"
fi

[ $fail = 0 ] && echo "ALL OK" || echo "SOME CHECKS FAILED"
exit $fail
