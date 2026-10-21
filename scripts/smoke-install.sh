#!/bin/sh
set -eu

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 path/to/agenthub-*.tar.gz" >&2
  exit 2
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$ARCHIVE")" && pwd)
ARCHIVE_NAME=$(basename -- "$ARCHIVE")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(printf '%s' "$ARCHIVE_NAME" | sed -n 's/^agenthub-\([0-9][0-9A-Za-z.-]*\)-linux-.*/\1/p')
[ -n "$VERSION" ]
docker run --rm -v "$ROOT_DIR:/input:ro" -v "$SCRIPT_DIR/install.sh:/tmp/agenthub-install.sh:ro" -e "ARCHIVE_NAME=$ARCHIVE_NAME" -e "VERSION=$VERSION" node:22-slim sh -eu -c '
  mkdir -p "/tmp/release/releases/download/v$VERSION" /tmp/agenthub-home /tmp/bin /tmp/smoke-bin
  cat > /tmp/smoke-bin/curl <<"EOF"
#!/bin/sh
set -eu
url=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    file://*) url="$1" ;;
    -o) shift; out="$1" ;;
  esac
  shift
done
cp "${url#file://}" "$out"
EOF
  chmod +x /tmp/smoke-bin/curl
  export PATH="/tmp/smoke-bin:$PATH"
  cp "/input/$ARCHIVE_NAME" "/tmp/release/releases/download/v$VERSION/$ARCHIVE_NAME"
  (cd "/tmp/release/releases/download/v$VERSION" && sha256sum "$ARCHIVE_NAME") > "/tmp/release/releases/download/v$VERSION/SHA256SUMS"
  HOME=/tmp/agenthub-home AGENTHUB_DIR=/tmp/agenthub-app AGENTHUB_HOME=/tmp/agenthub-home/data AGENTHUB_LINK_DIR=/tmp/bin AGENTHUB_RELEASE_BASE=/tmp/release AGENTHUB_SYSTEMCTL=/tmp/missing-systemctl sh /tmp/agenthub-install.sh --from-release "$VERSION"
  export PATH="/tmp/bin:$PATH"
  AGENTHUB_HOME=/tmp/agenthub-home/data agenthub doctor --json || true
  AGENTHUB_HOME=/tmp/agenthub-home/data agenthub daemon >/tmp/agenthub-daemon.log 2>&1 &
  daemon_pid=$!
  trap "kill $daemon_pid 2>/dev/null || true" EXIT
  ready=0
  i=0
  while [ "$i" -lt 30 ]; do
    if AGENTHUB_HEALTH_URL=http://127.0.0.1:7700/health node -e "fetch(process.env.AGY_HEALTH_URL || process.env.AGENTHUB_HEALTH_URL).then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()); }).catch(() => process.exit(1))" >/tmp/agenthub-health.json; then ready=1; break; fi
    i=$((i + 1)); sleep 1
  done
  [ "$ready" = 1 ]
  grep -q ok /tmp/agenthub-health.json
'
