#!/bin/sh
# Install a release archive on the current machine (no container) into throwaway directories,
# start the daemon on a spare port and check /health. Used for macOS in CI, where Docker is not
# available. Never touches the real ~/.agenthub, service manager or PATH.
set -eu

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 path/to/agenthub-*.tar.gz" >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARCHIVE_NAME=$(basename -- "$ARCHIVE")
VERSION=$(printf '%s' "$ARCHIVE_NAME" | sed -n 's/^agenthub-\([0-9][0-9A-Za-z.-]*\)-[a-z]*-[a-z0-9]*\.tar\.gz$/\1/p')
[ -n "$VERSION" ]

WORK=$(mktemp -d)
trap 'kill "${DAEMON_PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/release/releases/download/v$VERSION" "$WORK/home" "$WORK/bin" "$WORK/fakebin"
cp "$ARCHIVE" "$WORK/release/releases/download/v$VERSION/"
(cd "$WORK/release/releases/download/v$VERSION" && { command -v sha256sum >/dev/null && sha256sum "$ARCHIVE_NAME" || shasum -a 256 "$ARCHIVE_NAME"; }) > "$WORK/release/releases/download/v$VERSION/SHA256SUMS"
# Fake service managers: the smoke test must never register a real service. The
# fake git mirrors the macOS Xcode stub so this also proves release install does
# not need git or Node from PATH.
printf '#!/bin/sh\nexit 0\n' > "$WORK/fakebin/launchctl"
printf '#!/bin/sh\nexit 0\n' > "$WORK/fakebin/systemctl"
printf '#!/bin/sh\necho "xcode-select: note: no developer tools were found" >&2\nexit 1\n' > "$WORK/fakebin/git"
chmod +x "$WORK/fakebin/launchctl" "$WORK/fakebin/systemctl"
chmod +x "$WORK/fakebin/git"

PATH="$WORK/fakebin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK/home" AGENTHUB_DIR="$WORK/app" AGENTHUB_HOME="$WORK/home/data" AGENTHUB_LINK_DIR="$WORK/bin" \
  AGENTHUB_RELEASE_BASE="$WORK/release" AGENTHUB_SYSTEMCTL="$WORK/fakebin/systemctl" AGENTHUB_LAUNCHCTL="$WORK/fakebin/launchctl" \
  AGENTHUB_NO_BROWSER=1 sh "$SCRIPT_DIR/install.sh" --from-release "$VERSION" </dev/null

[ ! -x "$(PATH="$WORK/fakebin:/usr/bin:/bin:/usr/sbin:/sbin" command -v node 2>/dev/null || true)" ]
[ -x "$WORK/home/data/runtime/node-v22.x/bin/node" ]

PORT=7790
PATH="$WORK/fakebin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK/home" AGENTHUB_HOME="$WORK/home/data" AGENTHUB_PORT=$PORT "$WORK/bin/agenthub" daemon >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
i=0
until curl -fsS "http://127.0.0.1:$PORT/health" >"$WORK/health.json" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then echo "daemon did not become healthy:" >&2; tail -40 "$WORK/daemon.log" >&2; exit 1; fi
  sleep 1
done
cat "$WORK/health.json"; echo
grep -q '"ok":true' "$WORK/health.json"
grep -q "\"version\":\"$VERSION\"" "$WORK/health.json"
PATH="$WORK/fakebin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK/home" AGENTHUB_HOME="$WORK/home/data" "$WORK/bin/agenthub" doctor || true
echo "native smoke OK ($VERSION)"
