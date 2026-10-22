#!/bin/sh
# Fail if any native module (*.node) in a Linux release archive needs a newer glibc than MAX.
# Release archives must run on the oldest supported distro (Ubuntu 20.04 / Debian 11: glibc 2.31).
set -eu
ARCHIVE="$1"
MAX="${2:-2.31}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$ARCHIVE" -C "$WORK"
status=0
for f in $(find "$WORK" -name '*.node' -type f); do
  case "$(file -b "$f")" in *ELF*) ;; *) continue ;; esac
  need=$(objdump -T "$f" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -n 1)
  [ -n "$need" ] || continue
  if [ "$(printf '%s\n%s\n' "$need" "$MAX" | sort -V | tail -n 1)" != "$MAX" ]; then
    echo "✗ ${f#"$WORK"/} needs GLIBC_$need (max allowed $MAX)" >&2
    status=1
  else
    echo "✓ ${f#"$WORK"/} needs GLIBC_$need"
  fi
done
exit $status
