#!/bin/sh
# Verify the gym-sync endpoint behaves as intended.
#   sh check-webdav.sh https://pasky.or.cz/gym-sync [USER]
# Asks for the password (hidden; empty = only unauthenticated checks). Non-interactive callers
# may pass it in the GYM_SYNC_PASS environment variable. It never goes on a command line (argv):
# curl gets it via a private netrc file, so it doesn't show up in `ps`. The authenticated checks write selftest.json and
# can't delete it (DELETE is denied); remove it on the server if you care.
set -u
BASE=${1:?usage: $0 BASE_URL [USER]}
USER=${2:-gym}
PASS=${GYM_SYNC_PASS:-}
if [ -z "$PASS" ] && [ -t 0 ]; then
	printf 'Password for %s (empty to skip authenticated checks): ' "$USER"
	stty -echo; read -r PASS || PASS=; stty echo; echo
fi
PREFIX=${BASE#*://}; PREFIX=/${PREFIX#*/}   # URL path of the endpoint, e.g. /gym-sync
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
expect "GET directory"             "401 403" "$(code "$BASE/")"
expect "PUT"                       "401 403" "$(code -X PUT --data '{}' "$BASE/x.json")"
expect "PROPFIND"                  "401 403" "$(code -X PROPFIND -H 'Depth: 1' "$BASE/")"
expect "OPTIONS"                   "401 403" "$(code -X OPTIONS "$BASE/")"
expect "wrong password"            "401"     "$(code -u "$USER:wrong-password" "$BASE/state.json")"

if [ -n "$PASS" ]; then
	NETRC=$(umask 077; mktemp)
	trap 'rm -f "$NETRC"' EXIT
	HOSTNAME_=${BASE#*://}; HOSTNAME_=${HOSTNAME_%%/*}; HOSTNAME_=${HOSTNAME_%%:*}
	printf 'machine %s login %s password %s\n' "$HOSTNAME_" "$USER" "$PASS" > "$NETRC"
	A="--netrc-file $NETRC"
	body="{\"selftest\":$(date +%s)}"
	echo "== authenticated"
	# shellcheck disable=SC2086
	{
	expect "PUT selftest.json"         "201 204" "$(code $A -X PUT -H 'Content-Type: application/json' --data "$body" "$BASE/selftest.json")"
	got=$(curl -s $A "$BASE/selftest.json")
	if [ "$got" = "$body" ]; then echo "ok    GET returns what was PUT"; else echo "FAIL  GET returned: $got"; fail=1; fi
	hdrs=$(curl -s -D - -o /dev/null $A "$BASE/selftest.json" | tr -d '\r')
	echo "$hdrs" | grep -qi '^content-type: application/json' && echo "ok    Content-Type json" || { echo "FAIL  Content-Type"; fail=1; }
	echo "$hdrs" | grep -qi '^cache-control: no-store' && echo "ok    Cache-Control no-store" || { echo "FAIL  Cache-Control"; fail=1; }
	expect "PUT overwrite"             "204 201" "$(code $A -X PUT --data "$body" "$BASE/selftest.json")"
	expect "GET directory listing"     "403"     "$(code $A "$BASE/")"
	expect "PROPFIND"                  "403"     "$(code $A -X PROPFIND -H 'Depth: 1' "$BASE/")"
	expect "DELETE"                    "403"     "$(code $A -X DELETE "$BASE/selftest.json")"
	expect "MKCOL"                     "403"     "$(code $A -X MKCOL "$BASE/sub/")"
	expect "MOVE"                      "403"     "$(code $A -X MOVE -H "Destination: $PREFIX/moved.json" "$BASE/selftest.json")"
	expect "COPY"                      "403"     "$(code $A -X COPY -H "Destination: $PREFIX/copied.json" "$BASE/selftest.json")"
	expect "LOCK"                      "403"     "$(code $A -X LOCK "$BASE/selftest.json")"
	expect "PUT into subdirectory"     "403"     "$(code $A -X PUT --data '{}' "$BASE/sub/x.json")"
	expect "PUT x.php"                 "403"     "$(code $A -X PUT --data '<?php echo 1;' "$BASE/x.php")"
	expect "PUT x.php.json"            "403"     "$(code $A -X PUT --data '{}' "$BASE/x.php.json")"
	expect "PUT .htaccess"             "403"     "$(code $A -X PUT --data 'Options All' "$BASE/.htaccess")"
	expect "PUT %2e%2e traversal"      "400 403 404" "$(code $A -X PUT --data '{}' --path-as-is "$BASE/%2e%2e/evil.json")"
	expect "PUT too large (6 MB)"      "413"     "$(head -c 6000000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' $A -X PUT --data-binary @- "$BASE/big.json")"
	}
fi

[ $fail = 0 ] && echo "ALL OK" || echo "SOME CHECKS FAILED"
exit $fail
