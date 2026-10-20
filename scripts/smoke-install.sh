#!/bin/sh
set -eu

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 path/to/agenthub-*.tar.gz" >&2
  exit 2
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$ARCHIVE")" && pwd)
ARCHIVE_NAME=$(basename -- "$ARCHIVE")
docker run --rm -v "$ROOT_DIR:/input:ro" -e "ARCHIVE_NAME=$ARCHIVE_NAME" node:22-bookworm sh -eu -c '
  mkdir -p /tmp/agenthub /tmp/agenthub-home
  tar -xzf "/input/$ARCHIVE_NAME" -C /tmp/agenthub
  cd /tmp/agenthub
  npm ci --omit=dev
  AGENTHUB_HOME=/tmp/agenthub-home node dist/cli.js doctor --json || true
  AGENTHUB_HOME=/tmp/agenthub-home node dist/cli.js daemon >/tmp/agenthub-daemon.log 2>&1 &
  daemon_pid=$!
  trap "kill $daemon_pid 2>/dev/null || true" EXIT
  ready=0
  i=0
  while [ "$i" -lt 30 ]; do
    if node -e "fetch('http://127.0.0.1:7700/health').then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()); }).catch(() => process.exit(1))" >/tmp/agenthub-health.json; then ready=1; break; fi
    i=$((i + 1)); sleep 1
  done
  [ "$ready" = 1 ]
  grep -q '"ok":true' /tmp/agenthub-health.json
'
