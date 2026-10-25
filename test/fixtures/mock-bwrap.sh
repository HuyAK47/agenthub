#!/bin/sh
# Mock bwrap wrapper for testing without real bubblewrap.
# Skips bubblewrap arguments up to '--' and executes the inner command directly.
REAL_NODE=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--ro-bind" ] && [ "$3" = "/tmp/agenthub-brain-node" ]; then
    REAL_NODE="$2"
  fi
  if [ "$1" = "--" ]; then
    shift
    if [ "$1" = "/tmp/agenthub-brain-node" ]; then
      cmd="${REAL_NODE:-node}"
      shift
      exec "$cmd" "$@"
    fi
    exec "$@"
  fi
  shift
done
exec "$@"
