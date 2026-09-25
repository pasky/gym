#!/bin/sh
# Run setup-webdav.sh end-to-end WITHOUT root: paths point into a temp dir, root-only tools
# (chown, install -o, systemctl, apache2ctl, a2enmod, apt-get) are shimmed to drive a throwaway
# unprivileged Apache on 127.0.0.1:18081 whose vhost file gets edited like the real one.
#   sh server/test-setup-sandbox.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
PORT=18081
MOD=/usr/lib/apache2/modules
trap 'kill $(cat "$T/httpd.pid" 2>/dev/null) 2>/dev/null || true; rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/docroot" "$T/lock" "$T/srv"

# --- the script under test, re-pointed at the sandbox
cp "$HERE/gym-sync.conf.in" "$HERE/check-webdav.sh" "$T/srv/"
sed -e '/run as root/d' \
    -e "s|^HOST=.*|HOST=127.0.0.1:$PORT|" \
    -e "s|^VHOST=.*|VHOST=$T/vhost.conf|" \
    -e "s|^DIR=.*|DIR=$T/data|" \
    -e "s|^CONF=.*|CONF=$T/gym-sync.conf|" \
    -e "s|^HTPASSWD=.*|HTPASSWD=$T/gym-sync.htpasswd|" \
    -e "s|^LOCK=.*|LOCK=$T/setup.lock|" \
    -e 's|https://\$HOST|http://$HOST|g' \
    "$HERE/setup-webdav.sh" > "$T/srv/setup-webdav.sh"

# --- shims
for c in chown apt-get a2enmod; do printf '#!/bin/sh\nexit 0\n' > "$T/bin/$c"; done
cat > "$T/bin/install" <<'EOF'
#!/bin/sh
# drop -o/-g (needs root), keep the rest
args=; while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args="$args '$1'"; shift ;; esac; done
eval exec /usr/bin/install $args
EOF
cat > "$T/bin/apache2ctl" <<EOF
#!/bin/sh
exec /usr/sbin/apache2 -t -f $T/httpd.conf
EOF
cat > "$T/bin/systemctl" <<EOF
#!/bin/sh
exec /usr/sbin/apache2 -f $T/httpd.conf -k graceful
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

# --- a vhost file shaped like the real one, and a server config including it
cat > "$T/vhost.conf" <<EOF
<VirtualHost 127.0.0.1:$PORT>
	ServerName 127.0.0.1
	DocumentRoot $T/docroot
#	Include $T/gym-sync.conf
	Include $T/gym-sync.conf-extra
</VirtualHost>
EOF
touch "$T/gym-sync.conf-extra"
cat > "$T/httpd.conf" <<EOF
ServerRoot $T
ServerName localhost
Listen 127.0.0.1:$PORT
PidFile $T/httpd.pid
ErrorLog $T/error.log
TypesConfig /etc/mime.types
LoadModule mpm_prefork_module $MOD/mod_mpm_prefork.so
LoadModule authn_core_module $MOD/mod_authn_core.so
LoadModule authn_file_module $MOD/mod_authn_file.so
LoadModule auth_basic_module $MOD/mod_auth_basic.so
LoadModule authz_core_module $MOD/mod_authz_core.so
LoadModule authz_user_module $MOD/mod_authz_user.so
LoadModule alias_module $MOD/mod_alias.so
LoadModule mime_module $MOD/mod_mime.so
LoadModule dir_module $MOD/mod_dir.so
LoadModule headers_module $MOD/mod_headers.so
LoadModule dav_module $MOD/mod_dav.so
LoadModule dav_fs_module $MOD/mod_dav_fs.so
DAVLockDB $T/lock/DAVLock
<Directory />
    AllowOverride None
    Require all denied
</Directory>
IncludeOptional $T/vhost.conf
EOF
/usr/sbin/apache2 -f "$T/httpd.conf" -k start || { cat "$T/error.log"; exit 1; }
sleep 1

S="sh $T/srv/setup-webdav.sh"
fail=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; fail=1; }

echo "===== install"
$S install > "$T/out" 2>&1 && ok "install exit 0" || { bad "install failed"; cat "$T/out"; }
grep -c '^ok ' "$T/out" | xargs echo "      live checks passed:"
grep -q FAIL "$T/out" && { bad "check failures:"; grep FAIL "$T/out"; }
[ "$(grep -cE "^[[:space:]]*Include[[:space:]]+$T/gym-sync\.conf$" "$T/vhost.conf")" = 1 ] && ok "Include added once" || bad "Include not added"
grep -q '^selftest' "$T/gym-sync.htpasswd" && bad "selftest profile left behind" || ok "temporary selftest profile removed"
ls "$T/data" | grep -q '^selftest' && bad "selftest files left behind" || ok "selftest files removed"

echo "===== install again (idempotent)"
$S install > "$T/out" 2>&1 && ok "re-install exit 0" || { bad "re-install failed"; cat "$T/out"; }
[ "$(grep -cE "^[[:space:]]*Include[[:space:]]+$T/gym-sync\.conf$" "$T/vhost.conf")" = 1 ] && ok "still exactly one Include" || bad "Include duplicated"

echo "===== profiles"
P1=$($S add anna | sed -n 's/^Password: //p'); [ ${#P1} = 32 ] && ok "add anna -> 32-char password" || bad "add anna"
$S add anna >/dev/null 2>&1 && bad "duplicate add accepted" || ok "duplicate add refused"
$S add 'Bad Name' >/dev/null 2>&1 && bad "invalid name accepted" || ok "invalid name refused"
$S add selftest >/dev/null 2>&1 && bad "reserved name accepted" || ok "reserved name refused"
$S add selftest-other-x >/dev/null 2>&1 && bad "reserved prefix accepted" || ok "reserved prefix refused"
$S add "$(printf 'good\nbad')" >/dev/null 2>&1 && bad "multiline name accepted" || ok "multiline name refused"
$S add -- -x >/dev/null 2>&1 && bad "leading-hyphen name accepted" || ok "leading-hyphen name refused"
$S add -x >/dev/null 2>&1 && bad "leading-hyphen name accepted" || ok "leading-hyphen name refused (bare)"
grep -qv '^[a-z0-9][a-z0-9_-]*:' "$T/gym-sync.htpasswd" && bad "htpasswd has malformed lines" || ok "htpasswd well-formed"
P2=$($S add ben | sed -n 's/^Password: //p')
put() { printf 'machine 127.0.0.1 login %s password %s\n' "$1" "$2" > "$T/netrc"; curl -s -o /dev/null -w '%{http_code}' --netrc-file "$T/netrc" -X PUT --data "$4" "http://127.0.0.1:$PORT/gym-sync/$3.json"; }
[ "$(put anna "$P1" anna '{"who":"anna"}')" = 201 ] && ok "anna writes anna.json" || bad "anna can't write"
[ "$(put anna "$P1" ben '{"who":"evil"}')" = 401 ] && ok "anna can't write ben.json" || bad "anna wrote ben.json"
[ "$(put ben "$P2" ben '{"who":"ben"}')" = 201 ] && ok "ben writes ben.json" || bad "ben can't write"
[ "$(curl -s "http://127.0.0.1:$PORT/gym-sync/ben.json")" = '{"who":"ben"}' ] && ok "ben.json public read" || bad "public read"
P1b=$($S passwd anna | sed -n 's/^Password: //p')
[ "$(put anna "$P1" anna '{}')" = 401 ] && ok "old password rejected after passwd" || bad "old password still works"
[ "$(put anna "$P1b" anna '{"who":"anna2"}')" = 204 ] && ok "new password works" || bad "new password"
$S list | grep -q '^anna ' && $S list | grep -q '^ben ' && ok "list shows anna, ben" || bad "list"
# a live check must not touch real profiles' data
cp "$T/data/ben.json" "$T/ben.before"
$S check > "$T/out" 2>&1 && ok "check passes with real profiles present" || { bad "check failed"; grep FAIL "$T/out"; }
cmp -s "$T/data/ben.json" "$T/ben.before" && ok "check left ben.json intact" || bad "check modified ben.json"
cut -d: -f1 "$T/gym-sync.htpasswd" | sort | tr '\n' ' ' | grep -qx 'anna ben ' && ok "check left profiles intact" || bad "profiles changed by check: $(cut -d: -f1 "$T/gym-sync.htpasswd" | tr '\n' ' ')"
# commands are serialized: while someone holds the lock, another command waits
flock "$T/setup.lock" sleep 3 & LP=$!; sleep 0.5
lrc=0; timeout 1 $S list >/dev/null 2>&1 || lrc=$?; [ $lrc = 124 ] && ok "concurrent command waits for the lock" || bad "lock not honored"
wait $LP
$S remove ben >/dev/null
[ "$(put ben "$P2" ben '{}')" = 401 ] && ok "removed profile can't write" || bad "removed profile still writes"
[ -f "$T/data/ben.json" ] && ok "remove keeps data" || bad "remove deleted data"
$S remove anna --purge >/dev/null
[ -f "$T/data/anna.json" ] && bad "--purge kept data" || ok "remove --purge deletes data"
[ "$(stat -c %a "$T/gym-sync.htpasswd")" = 640 ] && ok "htpasswd mode 640" || bad "htpasswd mode $(stat -c %a "$T/gym-sync.htpasswd")"

echo "===== failing config rolls back"
cp "$T/srv/gym-sync.conf.in" "$T/conf.good"
echo "ThisIsNotADirective" >> "$T/srv/gym-sync.conf.in"
cp "$T/gym-sync.conf" "$T/conf.before"
$S install > "$T/out" 2>&1 && bad "broken install succeeded" || ok "broken install fails"
cmp -s "$T/gym-sync.conf" "$T/conf.before" && ok "snippet restored" || bad "snippet not restored"
/usr/sbin/apache2 -t -f "$T/httpd.conf" 2>/dev/null && ok "config valid after rollback" || bad "config broken after rollback"
cp "$T/conf.good" "$T/srv/gym-sync.conf.in"

echo "===== uninstall"
$S uninstall > "$T/out" 2>&1 && ok "uninstall exit 0" || { bad "uninstall failed"; cat "$T/out"; }
grep -qE "^[[:space:]]*Include[[:space:]]+$T/gym-sync\.conf$" "$T/vhost.conf" && bad "Include still there" || ok "Include removed"
grep -q "gym-sync.conf-extra" "$T/vhost.conf" && grep -q "^#	Include $T/gym-sync.conf" "$T/vhost.conf" && ok "unrelated/commented lines untouched" || bad "unrelated lines touched"
sleep 1
c=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/gym-sync/ben.json")
[ "$c" != 200 ] && ok "endpoint gone ($c)" || bad "endpoint still served"

[ $fail = 0 ] && echo "SANDBOX: ALL OK" || { echo "SANDBOX: FAILURES"; tail -5 "$T/error.log"; }
exit $fail
