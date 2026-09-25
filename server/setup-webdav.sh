#!/bin/sh
# Gym log sync storage on the existing Apache (mod_dav): https://pasky.or.cz/gym-sync/<profile>.json
# World-readable; each profile can only PUT its own file, with its own password. Run as root.
#
#   sudo sh server/setup-webdav.sh install         # set up / update Apache config (idempotent), then check
#   sudo sh server/setup-webdav.sh add NAME        # new profile; prints its generated password
#   sudo sh server/setup-webdav.sh passwd NAME     # new password for a profile
#   sudo sh server/setup-webdav.sh remove NAME [--purge]  # revoke write access (--purge: also delete data)
#   sudo sh server/setup-webdav.sh list            # profiles and their data files
#   sudo sh server/setup-webdav.sh check           # live endpoint checks (uses a temporary profile)
#   sudo sh server/setup-webdav.sh uninstall       # remove the vhost Include (keeps data and files)
#
# Profile names: [a-z0-9][a-z0-9_-]{0,31}; names starting with "selftest" are reserved for checks.
# Profile changes take effect immediately (no Apache reload). All commands are serialized by a lock.
#
# `install` does:
#   - apt-installs apache2-utils (htpasswd) if missing
#   - creates /var/lib/gym-sync (www-data, 0750): the only place Apache may write
#   - creates /etc/apache2/gym-sync.htpasswd (root:www-data 0640, bcrypt) if missing
#   - writes /etc/apache2/gym-sync.conf from gym-sync.conf.in
#   - adds "Include /etc/apache2/gym-sync.conf" to the pasky.or.cz HTTPS vhost
#   - enables mod_dav, mod_dav_fs, mod_headers; configtest; graceful reload
#     (on any failure or signal before the reload, the previous vhost/snippet are restored and re-tested)
#   - runs `check`; exits non-zero if it fails
set -eu

HOST=pasky.or.cz
VHOST=/etc/apache2/sites-available/pasky.or.cz-le-ssl.conf
URLPATH=/gym-sync
DIR=/var/lib/gym-sync
CONF=/etc/apache2/gym-sync.conf
HTPASSWD=/etc/apache2/gym-sync.htpasswd
LOCK=/run/lock/gym-sync-setup.lock
HERE=$(cd "$(dirname "$0")" && pwd)
STAMP=$(date +%Y%m%d%H%M%S)
# an active (uncommented) Include of exactly $CONF
CONF_RE=$(printf '%s' "$CONF" | sed 's/[.]/\\./g')
INCLUDE_RE="^[[:space:]]*Include[[:space:]]+${CONF_RE}[[:space:]]*$"

die() { echo "ERROR: $*" >&2; exit 1; }
usage() { sed -n '4,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
CMD=${1:-}; [ -n "$CMD" ] || usage
NAME=${2:-}

# one command at a time: htpasswd read-modify-write and config edits must not interleave
command -v flock >/dev/null || die "flock missing (util-linux)"
exec 9>"$LOCK"
flock -w 60 9 || die "another setup-webdav.sh is running (lock $LOCK)"

valid_name() {
	case "$1" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) return 1 ;; esac   # also rejects newlines
	[ ${#1} -le 32 ]
}
reserved_name() { case "$1" in selftest*) return 0 ;; esac; return 1; }
has_user() { [ -f "$HTPASSWD" ] && cut -d: -f1 "$HTPASSWD" | grep -qxF -- "$1"; }
genpass() {
	p=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)
	[ ${#p} = 32 ] || die "password generation failed"
	printf '%s' "$p"
}
# htpasswd_edit ARGS... : run htpasswd on a private copy, then atomically replace the real file
# (password, if any, comes on stdin; never on argv)
htpasswd_edit() {
	t=$(umask 077; mktemp "$HTPASSWD.XXXXXX")
	[ -f "$HTPASSWD" ] && cat "$HTPASSWD" > "$t"
	htpasswd "$@" "$t" "$NAME_" >/dev/null 2>&1 || { rm -f "$t"; die "htpasswd failed"; }
	chown root:www-data "$t"; chmod 0640 "$t"
	mv -f "$t" "$HTPASSWD"
}
set_password() { # set_password NAME PASSWORD
	NAME_=$1
	printf '%s\n' "$2" | htpasswd_edit -iB
}
del_user() { NAME_=$1; htpasswd_edit -D; }
need_installed() { grep -Eq "$INCLUDE_RE" "$VHOST" || echo "note: not installed in Apache yet; run 'install' too" >&2; }

cmd_check() {
	command -v curl >/dev/null || die "curl missing"
	rnd=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
	CHK_USER=selftest-$rnd CHK_OTHER=selftest-other-$rnd   # reserved prefix: can't be real profiles
	has_user "$CHK_USER" && die "temporary profile name collision, retry"
	pass=$(genpass)
	set_password "$CHK_USER" "$pass"
	# always drop exactly this run's temporary profile and files, even on failure or Ctrl-C
	trap 'del_user "$CHK_USER"; rm -f "$DIR/$CHK_USER.json" "$DIR/$CHK_OTHER.json"' EXIT
	trap 'exit 1' HUP INT TERM
	echo "== Checking https://$HOST$URLPATH (temporary profile '$CHK_USER')"
	rc=0
	GYM_SYNC_USER=$CHK_USER GYM_SYNC_PASS=$pass GYM_SYNC_OTHER=$CHK_OTHER \
		sh "$HERE/check-webdav.sh" "https://$HOST$URLPATH" </dev/null || rc=$?
	return $rc
}

case "$CMD" in
add|passwd)
	valid_name "$NAME" || die "profile name must match [a-z0-9][a-z0-9_-]{0,31}"
	reserved_name "$NAME" && die "names starting with 'selftest' are reserved for checks"
	command -v htpasswd >/dev/null || apt-get install -y apache2-utils
	if [ "$CMD" = add ]; then has_user "$NAME" && die "profile '$NAME' exists; use 'passwd $NAME' for a new password"
	else has_user "$NAME" || die "no profile '$NAME'"; fi
	pass=$(genpass)
	set_password "$NAME" "$pass"
	echo "Profile:  $NAME"
	echo "File:     https://$HOST$URLPATH/$NAME.json  (world-readable)"
	echo "Password: $pass"
	echo "(shown only now; store it in your password manager, then enter it in the app)"
	need_installed
	exit 0 ;;
remove)
	valid_name "$NAME" || die "usage: remove NAME [--purge]"
	has_user "$NAME" || die "no profile '$NAME'"
	del_user "$NAME"
	echo "Profile '$NAME' can no longer write."
	if [ "${3:-}" = "--purge" ]; then rm -f "$DIR/$NAME.json"; echo "Deleted $DIR/$NAME.json."
	elif [ -f "$DIR/$NAME.json" ]; then echo "Its data stays (and stays world-readable): $DIR/$NAME.json. Use --purge to delete it."; fi
	exit 0 ;;
list)
	[ -f "$HTPASSWD" ] || { echo "no profiles (not installed?)"; exit 0; }
	cut -d: -f1 "$HTPASSWD" | while read -r u; do
		f="$DIR/$u.json"
		if [ -f "$f" ]; then printf '%-20s %8s bytes  %s\n' "$u" "$(stat -c %s "$f")" "$(stat -c %y "$f" | cut -d. -f1)"
		else printf '%-20s (no data yet)\n' "$u"; fi
	done
	exit 0 ;;
check)
	cmd_check; exit $? ;;
uninstall)
	grep -Eq "$INCLUDE_RE" "$VHOST" || { echo "Not installed in $VHOST; nothing to do."; exit 0; }
	apache2ctl configtest >/dev/null 2>&1 || die "Apache config is already failing configtest; fix that first"
	cp -a "$VHOST" "$VHOST.bak-gym-sync-$STAMP"
	sed -i -E "\|$INCLUDE_RE|d" "$VHOST"
	if ! apache2ctl configtest; then
		cp -a "$VHOST.bak-gym-sync-$STAMP" "$VHOST"
		die "configtest failed after removing the Include; vhost restored, Apache not reloaded"
	fi
	systemctl reload apache2
	echo "Removed the Include from $VHOST (backup: $VHOST.bak-gym-sync-$STAMP) and reloaded Apache."
	echo "Left in place: $DIR (data), $CONF, $HTPASSWD. mod_dav is still enabled; 'a2dismod dav_fs dav' if unused."
	exit 0 ;;
install) ;;
*) usage ;;
esac

# ---------------- install ----------------
[ -f "$VHOST" ] || die "vhost $VHOST not found"
[ -f "$HERE/gym-sync.conf.in" ] || die "gym-sync.conf.in not found next to this script"
[ -f "$HERE/check-webdav.sh" ] || die "check-webdav.sh not found next to this script"
apache2ctl configtest >/dev/null 2>&1 || die "Apache config is already failing configtest; fix that first"

# 1. tools
command -v htpasswd >/dev/null || apt-get install -y apache2-utils
command -v openssl >/dev/null || die "openssl missing"
command -v curl >/dev/null || die "curl missing"

# 2. storage dir (outside every DocumentRoot) and password file
install -d -o www-data -g www-data -m 0750 "$DIR"
if [ ! -f "$HTPASSWD" ]; then
	install -o root -g www-data -m 0640 /dev/null "$HTPASSWD"
fi

# 3. config changes, transactional: back up, apply, configtest; restore everything on any failure
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

# 4. verify the live endpoint
echo
rc=0; cmd_check || rc=$?
echo
echo "Endpoint: https://$HOST$URLPATH/<profile>.json (world-readable; PUT needs that profile's password)"
echo "Data dir: $DIR (include it in backups)"
[ -s "$HTPASSWD" ] && { echo "Profiles:"; cut -d: -f1 "$HTPASSWD" | grep -v '^selftest' | sed 's/^/  /'; } \
	|| echo "No profiles yet: sudo sh $0 add NAME"
[ $rc = 0 ] || die "Apache config is installed, but the live endpoint checks FAILED (see above). Fix, or run 'uninstall'."
