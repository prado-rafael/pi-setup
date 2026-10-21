#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for cmd in git node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "Missing %s. Install Git and Node.js >=22.19 (including npm), then try again.\n" "$cmd" >&2
    exit 1
  fi
done
exec node "$ROOT/scripts/pi-setup.mjs" install "$@"
