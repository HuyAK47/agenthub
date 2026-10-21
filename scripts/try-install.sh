#!/bin/sh
# Try the release installer by hand, as a brand-new user would.
#
# Builds the release archive, then starts a throwaway container (node:22-slim: no compiler, no
# systemd, no agy/codex/claude) that installs AgentHub from that archive and runs the daemon on
# port 7800, so it does not clash with a hub already running on 7700. Open the printed URL in
# your browser and walk through the first-run setup; the terminal drops into a shell inside the
# container (run `agenthub doctor`, try the uninstaller…). `exit` stops and deletes the container.
#
# Usage: scripts/try-install.sh [--no-build] [--port 7800]
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT=7800
BUILD=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --port) PORT="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT_DIR"
if [ "$BUILD" = 1 ]; then
  npm run package
fi
ARCHIVE=$(find release -maxdepth 1 -name 'agenthub-*-linux-x64.tar.gz' -print | sort | tail -n 1)
[ -n "$ARCHIVE" ] || { echo "No release/agenthub-*-linux-x64.tar.gz; run without --no-build." >&2; exit 1; }
VERSION=$(basename "$ARCHIVE" | sed -n 's/^agenthub-\([0-9][0-9A-Za-z.-]*\)-linux-x64\.tar\.gz$/\1/p')

# Lay the archive out like a GitHub Release so install.sh --from-release can fetch it.
BASE=$(mktemp -d)
trap 'rm -rf "$BASE"' EXIT
mkdir -p "$BASE/releases/download/v$VERSION"
cp "$ARCHIVE" release/SHA256SUMS "$BASE/releases/download/v$VERSION/"
cp scripts/install.sh "$BASE/install.sh"
chmod -R a+rX "$BASE"

echo "==> Thử cài AgentHub v$VERSION trên máy sạch (container node:22-slim), cổng $PORT"
TTY_FLAG=-i
[ -t 0 ] && TTY_FLAG=-it
docker run --rm $TTY_FLAG --network host -v "$BASE:/input:ro" -e "PORT=$PORT" -e "VERSION=$VERSION" node:22-slim sh -c '
  set -e
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl ca-certificates git >/dev/null 2>&1
  useradd -m tester
  su tester -c "
    set -e
    cd ~
    AGENTHUB_RELEASE_BASE=file:///input sh /input/install.sh --from-release $VERSION </dev/null
    export PATH=\$HOME/.local/bin:\$PATH
    AGENTHUB_PORT=$PORT agenthub daemon > /tmp/daemon.log 2>&1 &
    sleep 5
    echo
    echo ================================================================
    echo Mở trong trình duyệt: http://127.0.0.1:$PORT/#token=\$(cat ~/.agenthub/token)
    echo Bạn đang ở terminal của máy thử. Có thể chạy:
    echo   agenthub doctor
    echo   tail -f /tmp/daemon.log
    echo   sh /input/install.sh --uninstall
    echo Gõ exit để dừng và xoá máy thử.
    echo ================================================================
    exec bash
  "
'
