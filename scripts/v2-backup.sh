#!/usr/bin/env bash
set -euo pipefail

root=/opt/ccer-screening
backups="$root/data/backups"
stamp=$(date +%Y%m%d-%H%M%S)
snapshot="$backups/ccer_v2-$stamp.db"
archive="$backups/ccer-v2-$stamp.tar.gz"
mkdir -p "$backups"
chmod 700 "$backups"
umask 077
/usr/local/bin/node "$root/scripts/v2-snapshot.mjs" "$root/data/ccer_v2.db" "$snapshot"
tar -czf "$archive" -C "$backups" "$(basename "$snapshot")" -C "$root" data/keys data/official-originals data/registry-files
tar -tzf "$archive" >/dev/null
sha256sum "$archive" > "$archive.sha256"
rm -f -- "$snapshot"
find "$backups" -maxdepth 1 -type f -name 'ccer-v2-*.tar.gz' -mtime +30 -delete
find "$backups" -maxdepth 1 -type f -name 'ccer-v2-*.tar.gz.sha256' -mtime +30 -delete
echo "backup_ok $(basename "$archive")"
