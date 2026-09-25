#!/bin/sh
# Copy the static app to ~/WWW/gym, cache-busting asset URLs with the git revision.
set -e
cd "$(dirname "$0")"
DEST="${1:-$HOME/WWW/gym}"
REV=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
[ -n "$(git status --porcelain 2>/dev/null)" ] && REV="$REV-dirty$(date +%s)"
mkdir -p "$DEST"
rsync -a --delete --exclude .git --exclude deploy.sh --exclude README.md --exclude test ./ "$DEST/"
sed -i "s/?v=dev/?v=$REV/g" "$DEST/index.html"
echo "deployed $REV to $DEST"
