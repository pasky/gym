#!/bin/sh
# Set up https://pasky.or.cz/gym-sync/ : password-protected GET/PUT storage for the gym app,
# served by the existing Apache via mod_dav. Run as root. Safe to re-run (idempotent).
#
#   sudo sh server/setup-webdav.sh                  # first run: generates and prints a password
#   sudo sh server/setup-webdav.sh --reset-password # new password
#   sudo sh server/setup-webdav.sh --uninstall      # remove the Include (keeps data and files)
#
# What it does:
#   - apt-installs apache2-utils (htpasswd) if missing
#   - creates /var/lib/gym-sync (www-data, 0750): the only place Apache may write
#   - creates /etc/apache2/gym-sync.htpasswd (user "gym", bcrypt, random 32-char password)
#   - writes /etc/apache2/gym-sync.conf from gym-sync.conf.in
#   - adds "Include /etc/apache2/gym-sync.conf" to the pasky.or.cz HTTPS vhost
#   - enables mod_dav, mod_dav_fs, mod_headers; configtest; graceful reload
#     (on any failure before the reload, the previous vhost/snippet are restored and re-tested)
#   - runs check-webdav.sh against the live endpoint (asks for the password on re-runs);
#     exits non-zero if it fails
set -eu

HOST=pasky.or.cz
VHOST=/etc/apache2/sites-available/pasky.or.cz-le-ssl.conf
URLPATH=/gym-sync
DIR=/var/lib/gym-sync
CONF=/etc/apache2/gym-sync.conf
HTPASSWD=/etc/apache2/gym-sync.htpasswd
DAVUSER=gym
HERE=$(cd "$(dirname "$0")" && pwd)
STAMP=$(date +%Y%m%d%H%M%S)
# an active (uncommented) Include of exactly $CONF
CONF_RE=$(printf '%s' "$CONF" | sed 's/[.]/\\./g')
INCLUDE_RE="^[[:space:]]*Include[[:space:]]+${CONF_RE}[[:space:]]*$"

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$VHOST" ] || die "vhost $VHOST not found"
[ -f "$HERE/gym-sync.conf.in" ] || die "gym-sync.conf.in not found next to this script"
[ -f "$HERE/check-webdav.sh" ] || die "check-webdav.sh not found next to this script"
apache2ctl configtest >/dev/null 2>&1 || die "Apache config is already failing configtest; fix that first"

if [ "${1:-}" = "--uninstall" ]; then
	grep -Eq "$INCLUDE_RE" "$VHOST" || { echo "Not installed in $VHOST; nothing to do."; exit 0; }
	cp -a "$VHOST" "$VHOST.bak-gym-sync-$STAMP"
	sed -i -E "\|$INCLUDE_RE|d" "$VHOST"
	if ! apache2ctl configtest; then
		cp -a "$VHOST.bak-gym-sync-$STAMP" "$VHOST"
		die "configtest failed after removing the Include; vhost restored, Apache not reloaded"
	fi
	systemctl reload apache2
	echo "Removed the Include from $VHOST (backup: $VHOST.bak-gym-sync-$STAMP) and reloaded Apache."
	echo "Left in place: $DIR (data), $CONF, $HTPASSWD. mod_dav is still enabled; 'a2dismod dav_fs dav' if unused."
	exit 0
fi

# 1. tools
command -v htpasswd >/dev/null || apt-get install -y apache2-utils
command -v openssl >/dev/null || die "openssl missing"
command -v curl >/dev/null || die "curl missing"

# 2. storage dir, outside every DocumentRoot
install -d -o www-data -g www-data -m 0750 "$DIR"

# 3. credentials (bcrypt; password via stdin so it never shows up in ps)
NEWPASS=
if [ ! -s "$HTPASSWD" ] || [ "${1:-}" = "--reset-password" ]; then
	NEWPASS=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)
	[ ${#NEWPASS} = 32 ] || die "password generation failed"
	HTTMP=$(umask 077; mktemp "$HTPASSWD.XXXXXX")
	printf '%s\n' "$NEWPASS" | htpasswd -ciB "$HTTMP" "$DAVUSER" 2>/dev/null || { rm -f "$HTTMP"; die "htpasswd failed"; }
	chown root:www-data "$HTTMP"
	chmod 0640 "$HTTMP"
	mv -f "$HTTMP" "$HTPASSWD"
	echo "New password for user '$DAVUSER': $NEWPASS  (also repeated at the end)"
fi

# 4. config changes, transactional: back up, apply, configtest; restore everything on any failure
BK=$(mktemp -d)
cp -a "$VHOST" "$BK/vhost"
[ -f "$CONF" ] && cp -a "$CONF" "$BK/conf"
applied=0
rollback() {
	[ $applied = 1 ] && return 0
	echo "!! rolling back Apache config changes" >&2
	cp -a "$BK/vhost" "$VHOST"
	if [ -f "$BK/conf" ]; then cp -a "$BK/conf" "$CONF"; else rm -f "$CONF"; fi
	if apache2ctl configtest >/dev/null 2>&1; then echo "!! previous config restored and passes configtest; Apache was NOT reloaded" >&2
	else echo "!! RESTORED CONFIG STILL FAILS configtest: do not restart Apache before fixing it (backups in $BK)" >&2; return 0; fi
	rm -rf "$BK"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM   # dash skips EXIT traps on signals; route them through exit

tmp=$(mktemp)
sed -e "s|@URLPATH@|$URLPATH|g" -e "s|@DIR@|$DIR|g" -e "s|@HTPASSWD@|$HTPASSWD|g" "$HERE/gym-sync.conf.in" > "$tmp"
install -o root -g root -m 0644 "$tmp" "$CONF"
rm -f "$tmp"

VHOST_EDITED=
if ! grep -Eq "$INCLUDE_RE" "$VHOST"; then
	[ "$(grep -c '^</VirtualHost>' "$VHOST")" = 1 ] || die "expected exactly one '</VirtualHost>' line in $VHOST"
	sed -i "s|^</VirtualHost>|\tInclude $CONF\n</VirtualHost>|" "$VHOST"
	grep -Eq "$INCLUDE_RE" "$VHOST" || die "failed to add the Include to $VHOST"
	VHOST_EDITED=1
fi

a2enmod -q dav dav_fs headers
apache2ctl configtest || die "apache2ctl configtest failed"
systemctl reload apache2
applied=1
trap - EXIT HUP INT TERM
[ -n "$VHOST_EDITED" ] && cp -a "$BK/vhost" "$VHOST.bak-gym-sync-$STAMP" && echo "vhost edited (backup: $VHOST.bak-gym-sync-$STAMP)"
rm -rf "$BK"
sleep 2

# 5. verify the live endpoint
echo
echo "== Checking https://$HOST$URLPATH"
rc=0
GYM_SYNC_PASS=$NEWPASS sh "$HERE/check-webdav.sh" "https://$HOST$URLPATH" "$DAVUSER" || rc=$?
rm -f "$DIR/selftest.json"

echo
echo "Endpoint: https://$HOST$URLPATH/state.json"
echo "User:     $DAVUSER"
if [ -n "$NEWPASS" ]; then
	echo "Password: $NEWPASS"
	echo "(shown only now; store it in your password manager, then enter it in the app)"
fi
echo "Data dir: $DIR (include it in backups)"
[ $rc = 0 ] || die "Apache config is installed, but the live endpoint checks FAILED (see above). Fix, or run with --uninstall."
