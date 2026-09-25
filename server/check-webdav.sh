#!/bin/sh
# Verify the gym-sync endpoint behaves as intended.
#   sh check-webdav.sh https://pasky.or.cz/gym-sync
# Authenticated checks need a THROWAWAY profile: they overwrite <profile>.json. setup-webdav.sh
# `check` creates a temporary "selftest-<random>" profile for this automatically. Standalone, pass
# GYM_SYNC_USER / GYM_SYNC_PASS in the environment, or answer the prompt (empty = skip).
# Profile names starting with "selftest" are reserved for checks, so the random names used here
# for "missing" and "someone else's" profiles can't collide with real data.
# The password never goes on a command line: curl gets it via a private netrc file.
set -u
BASE=${1:?usage: $0 BASE_URL}
RND=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
USER=${GYM_SYNC_USER:-selftest}
PASS=${GYM_SYNC_PASS:-}
OTHER=${GYM_SYNC_OTHER:-selftest-other-$RND}   # a profile the test user must NOT be able to write
MISSING=selftest-missing-$RND
PREFIX=${BASE#*://}; PREFIX=/${PREFIX#*/}   # URL path of the endpoint, e.g. /gym-sync
if [ -z "$PASS" ] && [ -t 0 ]; then
	printf 'Password of throwaway profile "%s" (empty to skip authenticated checks): ' "$USER"
	stty -echo; read -r PASS || PASS=; stty echo; echo
fi
fail=0

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { # expect "description" "allowed codes (space separated)" actual
	case " $2 " in
		*" $3 "*) echo "ok    $1 -> $3" ;;
		*) echo "FAIL  $1 -> $3 (expected $2)"; fail=1 ;;
	esac
}
DENY="401 403"

echo "== unauthenticated"
expect "GET missing profile (public read)" "404"   "$(code "$BASE/$MISSING.json")"
expect "GET directory"             "403"     "$(code "$BASE/")"
expect "GET x.php"                 "403"     "$(code "$BASE/x.php")"
expect "GET Uppercase.json"        "403"     "$(code "$BASE/Upper.json")"
expect "PUT"                       "401"     "$(code -X PUT --data '{}' "$BASE/$USER.json")"
expect "PROPFIND"                  "$DENY"   "$(code -X PROPFIND -H 'Depth: 1' "$BASE/")"
expect "OPTIONS"                   "$DENY"   "$(code -X OPTIONS "$BASE/$USER.json")"
expect "DELETE"                    "$DENY"   "$(code -X DELETE "$BASE/$USER.json")"
expect "PUT wrong password"        "401"     "$(code -u "$USER:wrong-password" -X PUT --data '{}' "$BASE/$USER.json")"

if [ -n "$PASS" ]; then
	NETRC=$(umask 077; mktemp)
	trap 'rm -f "$NETRC"' EXIT
	HOSTNAME_=${BASE#*://}; HOSTNAME_=${HOSTNAME_%%/*}; HOSTNAME_=${HOSTNAME_%%:*}
	printf 'machine %s login %s password %s\n' "$HOSTNAME_" "$USER" "$PASS" > "$NETRC"
	A="--netrc-file $NETRC"
	F="$BASE/$USER.json"
	body="{\"selftest\":$(date +%s)}"
	echo "== authenticated as profile '$USER'"
	# shellcheck disable=SC2086
	{
	expect "PUT own file"              "201 204" "$(code $A -X PUT -H 'Content-Type: application/json' --data "$body" "$F")"
	got=$(curl -s "$F")
	if [ "$got" = "$body" ]; then echo "ok    public GET returns what was PUT"; else echo "FAIL  public GET returned: $got"; fail=1; fi
	hdrs=$(curl -s -D - -o /dev/null "$F" | tr -d '\r')
	echo "$hdrs" | grep -qi '^content-type: application/json' && echo "ok    Content-Type json" || { echo "FAIL  Content-Type"; fail=1; }
	echo "$hdrs" | grep -qi '^cache-control: no-store' && echo "ok    Cache-Control no-store" || { echo "FAIL  Cache-Control"; fail=1; }
	expect "PUT own file again"        "204 201" "$(code $A -X PUT --data "$body" "$F")"
	expect "PUT other profile's file"  "$DENY"   "$(code $A -X PUT --data '{"pwned":1}' "$BASE/$OTHER.json")"
	expect "  ... and it wasn't written" "404 200" "$(code "$BASE/$OTHER.json")"
	[ "$(curl -s "$BASE/$OTHER.json")" = '{"pwned":1}' ] && { echo "FAIL  other profile's file was overwritten!"; fail=1; }
	expect "PROPFIND"                  "$DENY"   "$(code $A -X PROPFIND -H 'Depth: 1' "$BASE/")"
	expect "DELETE own file"           "$DENY"   "$(code $A -X DELETE "$F")"
	expect "MKCOL"                     "$DENY"   "$(code $A -X MKCOL "$BASE/sub/")"
	expect "MOVE"                      "$DENY"   "$(code $A -X MOVE -H "Destination: $PREFIX/moved.json" "$F")"
	expect "COPY"                      "$DENY"   "$(code $A -X COPY -H "Destination: $PREFIX/copied.json" "$F")"
	expect "LOCK"                      "$DENY"   "$(code $A -X LOCK "$F")"
	expect "PUT into subdirectory"     "403"     "$(code $A -X PUT --data '{}' "$BASE/$USER/x.json")"
	expect "PUT x.php"                 "403"     "$(code $A -X PUT --data '<?php echo 1;' "$BASE/x.php")"
	expect "PUT $USER.php.json"        "403"     "$(code $A -X PUT --data '{}' "$BASE/$USER.php.json")"
	expect "PUT .htaccess"             "403"     "$(code $A -X PUT --data 'Options All' "$BASE/.htaccess")"
	expect "PUT %2e%2e traversal"      "400 403 404" "$(code $A -X PUT --data '{}' --path-as-is "$BASE/%2e%2e/$USER.json")"
	expect "PUT too large (6 MB)"      "413"     "$(head -c 6000000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' $A -X PUT --data-binary @- "$F")"
	}
fi

[ $fail = 0 ] && echo "ALL OK" || echo "SOME CHECKS FAILED"
exit $fail
