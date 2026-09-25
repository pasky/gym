#!/bin/sh
# Test gym-sync.conf.in on a throwaway, unprivileged Apache (port 18080), no root needed.
#   sh server/test-local.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
PORT=18080
MOD=/usr/lib/apache2/modules
trap 'kill $(cat "$T/httpd.pid" 2>/dev/null) 2>/dev/null || true; rm -rf "$T"' EXIT

mkdir -p "$T/data" "$T/docroot" "$T/lock"
printf '%s\n' testpass | htpasswd -ciB "$T/htpasswd" selftest 2>/dev/null
printf '%s\n' alicepass | htpasswd -iB "$T/htpasswd" alice 2>/dev/null
echo '{"alice":"original"}' > "$T/data/alice.json"
sed -e "s|@URLPATH@|/gym-sync|g" -e "s|@DIR@|$T/data|g" -e "s|@HTPASSWD@|$T/htpasswd|g" "$HERE/gym-sync.conf.in" > "$T/gym-sync.conf"

cat > "$T/httpd.conf" <<EOF
ServerRoot $T
ServerName localhost
Listen 127.0.0.1:$PORT
PidFile $T/httpd.pid
ErrorLog $T/error.log
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
LoadModule status_module $MOD/mod_status.so
TypesConfig /etc/mime.types
DAVLockDB $T/lock/DAVLock
# same defaults as Debian's apache2.conf
<Directory />
    Options FollowSymLinks
    AllowOverride None
    Require all denied
</Directory>
<FilesMatch "^\.ht">
    Require all denied
</FilesMatch>
# Simulate inherited executable handlers, like Debian's global PHP config
# (<FilesMatch ".+\.ph(ar|p|tml)$"> SetHandler application/x-httpd-php). mod_status stands in
# for PHP: if it ever runs, GETs return a status page instead of the stored file.
<FilesMatch ".+\.ph(ar|p|tml)$">
    SetHandler server-status
</FilesMatch>
<FilesMatch "\.json$">
    SetHandler server-status
</FilesMatch>
AddHandler server-status .json
DocumentRoot $T/docroot
<VirtualHost 127.0.0.1:$PORT>
    DocumentRoot $T/docroot
    Include $T/gym-sync.conf
</VirtualHost>
EOF

/usr/sbin/apache2 -t -f "$T/httpd.conf"
/usr/sbin/apache2 -f "$T/httpd.conf" -k start || { cat "$T/error.log"; exit 1; }
sleep 1
rc=0
GYM_SYNC_USER=selftest GYM_SYNC_PASS=testpass GYM_SYNC_OTHER=alice sh "$HERE/check-webdav.sh" "http://127.0.0.1:$PORT/gym-sync" </dev/null || rc=$?
grep -q original "$T/data/alice.json" && echo "ok    alice.json untouched" || { echo "FAIL  alice.json modified"; rc=1; }
echo "-- files written:"; ls -la "$T/data"
[ $rc = 0 ] || { echo "-- error.log:"; tail -20 "$T/error.log"; }
exit $rc
