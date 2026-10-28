#!/bin/sh
set -eu

state_home=${CONTINUITY_HOME:-${HOME:-/root}}
expected_uid=${CONTINUITY_EXPECTED_UID:-$(id -u)}
listeners="$state_home/.letta/listeners"
mkdir -p "$listeners"
chmod 0700 "$listeners"

# Container PID namespaces are recreated on restart. Preserve regular lock
# files from the previous namespace as evidence, then let the sole replacement
# listener create a fresh lock. Unsafe paths and ownership fail closed.
for lock in "$listeners"/*.lock; do
  [ -e "$lock" ] || continue
  if [ -L "$lock" ] || [ ! -f "$lock" ]; then
    echo "unsafe listener lock path: $lock" >&2
    exit 1
  fi
  owner=$(stat -c '%u' "$lock")
  [ "$owner" = "$expected_uid" ] || {
    echo "listener lock has unexpected ownership: $lock" >&2
    exit 1
  }
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  suffix=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
  orphan="$lock.orphaned-$timestamp-container-$suffix"
  mv -- "$lock" "$orphan"
  chmod 0600 "$orphan"
done

cd "$state_home"
exec "$@"
