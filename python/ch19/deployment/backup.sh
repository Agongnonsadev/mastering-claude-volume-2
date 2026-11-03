#!/usr/bin/env sh
# Chapter 19: a copy of the Comptoir's databases, to run every night on the server (cron), from this folder.
# SQLite copied hot by its own .backup command: the copy is consistent even if the Comptoir is writing.
# The copies contain customer data: keep them on the server or encrypted, and erase them
# according to the same periods as the databases (here, the last 14).
set -eu
target="backups/$(date +%Y-%m-%d)"
mkdir -p "$target"
for db in shop conversations budget; do
  docker compose exec -T comptoir python -c \
    "import sqlite3; s=sqlite3.connect('/data/$db.sqlite3'); d=sqlite3.connect('/data/copy-$db.sqlite3'); s.backup(d); d.close()"
  docker compose cp "comptoir:/data/copy-$db.sqlite3" "$target/$db.sqlite3"
  docker compose exec -T comptoir rm "/data/copy-$db.sqlite3"
done
ls -1d backups/* | sort | head -n -14 | xargs -r rm -rf
