#!/bin/sh
# Runs one of the plugin's Python scripts with the system's Python (no dependency outside the standard library).
folder="$(dirname "$0")"
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c "import sys" >/dev/null 2>&1; then
    exec "$py" "$folder/$1.py"
  fi
done
echo "secret-guard plugin: no Python interpreter found." >&2
exit 1
