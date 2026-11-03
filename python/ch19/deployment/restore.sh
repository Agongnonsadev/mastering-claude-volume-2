#!/usr/bin/env sh
# Chapter 21: put back a database saved by backup.sh. On the server, from this folder:
#   ./restore.sh 2026-10-22 conversations        (or shop, or budget)
# The Comptoir is stopped during the copy. The copy is made in a throwaway container, as root,
# then the file is given back to the Comptoir's user: copied by “docker cp”, a database belongs to
# root and the Comptoir, without privileges, can no longer write to it (tried in chapter 21).
set -eu
date="$1"; db="$2"
test -f "backups/$date/$db.sqlite3" || { echo "No backup backups/$date/$db.sqlite3" >&2; exit 1; }
docker compose stop comptoir
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups:ro" --entrypoint sh comptoir -c \
  "cp /backups/$date/$db.sqlite3 /data/$db.sqlite3 && chown comptoir:comptoir /data/$db.sqlite3"
docker compose start comptoir
echo "Database $db put back to its state of $date. Check /health and the dashboard."
