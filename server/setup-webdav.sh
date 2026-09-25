#!/bin/sh
# Set up https://pasky.or.cz/gym-sync/ : password-protected GET/PUT storage for the gym app,
# served by the existing Apache via mod_dav. Run as root. Safe to re-run (idempotent).
#
#   sudo sh server/setup-webdav.sh                  # first run: generates and prints a password
#   sudo sh server/setup-webdav.sh --reset-password # new password
#   sudo sh server/setup-webdav.sh --uninstall      # remove the Include, disable config (keeps data)
#
# What it does:
#   - apt-installs apache2-utils (htpasswd) if missing
#   - creates /var/lib/gym-sync (www-data, 0750): the only place Apache may write
#   - creates /etc/apache2/gym-sync.htpasswd (user "gym", bcrypt, random 32-char password)
#   - writes /etc/apache2/gym-sync.conf from gym-sync.conf.in
#   - adds "Include /etc/apache2/gym-sync.conf" to the pasky.or.cz HTTPS vhost (backup kept)
#   - enables mod_dav, mod_dav_fs, mod_headers; configtest; graceful reload
#   - runs check-webdav.sh against the live endpoint
set -eu

HOST=pasky.or.cz
VHOST=/etc/apache2/sites-available/pasky.or.cz-le-ssl.conf
URLPATH=/gym-sync
DIR=/var/lib/gym-sync
CONF=/etc/apache2/gym-sync.conf
HTPASSWD=/etc/apache2/gym-sync.htpasswd
DAVUSER=gym
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$VHOST" ] || die "vhost $VHOST not found"
[ "$(grep -c '^</VirtualHost>' "$VHOST")" = 1 ] || die "expected exactly one </VirtualHost> in $VHOST"
[ -f "$HERE/gym-sync.conf.in" ] || die "gym-sync.conf.in not found next to this script"

if [ "${1:-}" = "--uninstall" ]; then
	cp -a "$VHOST" "$VHOST.bak-gym-sync-$(date +%Y%m%d%H%M%S)"
	sed -i "\|Include $CONF|d" "$VHOST"
	apache2ctl configtest && systemctl reload apache2
	echo "Removed the Include from $VHOST and reloaded Apache."
	echo "Left in place: $DIR (data), $CONF, $HTPASSWD. mod_dav is still enabled; 'a2dismod dav_fs dav' if unused."
	exit 0
fi

# 1. tools
command -v htpasswd >/dev/null || apt-get install -y apache2-utils
command -v openssl >/dev/null || die "openssl missing"

# 2. storage dir, outside every DocumentRoot
install -d -o www-data -g www-data -m 0750 "$DIR"

# 3. credentials (bcrypt; password via stdin so it never shows up in ps)
NEWPASS=
if [ ! -s "$HTPASSWD" ] || [ "${1:-}" = "--reset-password" ]; then
	NEWPASS=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)
	[ ${#NEWPASS} = 32 ] || die "password generation failed"
	printf '%s\n' "$NEWPASS" | htpasswd -ciB "$HTPASSWD" "$DAVUSER" 2>/dev/null
	chown root:www-data "$HTPASSWD"
	chmod 0640 "$HTPASSWD"
fi

# 4. config snippet
tmp=$(mktemp)
sed -e "s|@URLPATH@|$URLPATH|g" -e "s|@DIR@|$DIR|g" -e "s|@HTPASSWD@|$HTPASSWD|g" "$HERE/gym-sync.conf.in" > "$tmp"
install -o root -g root -m 0644 "$tmp" "$CONF"
rm -f "$tmp"

# 5. hook into the HTTPS vhost only (plain HTTP just redirects to HTTPS)
BACKUP=
if ! grep -q "Include $CONF" "$VHOST"; then
	BACKUP="$VHOST.bak-gym-sync-$(date +%Y%m%d%H%M%S)"
	cp -a "$VHOST" "$BACKUP"
	sed -i "s|^</VirtualHost>|\tInclude $CONF\n</VirtualHost>|" "$VHOST"
fi

# 6. modules, test, reload (roll back the vhost edit if the config doesn't parse)
a2enmod -q dav dav_fs headers
if ! apache2ctl configtest; then
	[ -n "$BACKUP" ] && cp -a "$BACKUP" "$VHOST"
	die "apache2ctl configtest failed; vhost restored from backup, Apache NOT reloaded"
fi
systemctl reload apache2
sleep 1

# 7. verify the live endpoint
echo
echo "== Checking https://$HOST$URLPATH"
PASS_FOR_CHECK=${NEWPASS:-${GYM_SYNC_PASS:-}}
[ -z "$PASS_FOR_CHECK" ] && echo "(password unchanged: set GYM_SYNC_PASS=... to also run the authenticated checks)"
sh "$HERE/check-webdav.sh" "https://$HOST$URLPATH" "$DAVUSER" "$PASS_FOR_CHECK" || echo "!! checks failed, see above"
rm -f "$DIR/selftest.json"

echo
echo "Endpoint: https://$HOST$URLPATH/state.json"
echo "User:     $DAVUSER"
if [ -n "$NEWPASS" ]; then
	echo "Password: $NEWPASS"
	echo "(shown only now; store it in your password manager, then enter it in the app)"
fi
echo "Data dir: $DIR (include it in backups)"
