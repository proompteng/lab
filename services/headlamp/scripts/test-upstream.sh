#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

HEADLAMP_REF="${HEADLAMP_REF:-v0.40.1}"
HEADLAMP_SHA="${HEADLAMP_SHA:-434a12263a6bd9d25f86f8bfa00d9992ac2672e3}"

git init "$WORK_DIR" >/dev/null
git -C "$WORK_DIR" remote add origin https://github.com/kubernetes-sigs/headlamp.git
git -C "$WORK_DIR" fetch --depth 1 origin "$HEADLAMP_REF" >/dev/null
git -C "$WORK_DIR" checkout --detach FETCH_HEAD >/dev/null

if [ "$(git -C "$WORK_DIR" rev-parse HEAD)" != "$HEADLAMP_SHA" ]; then
  echo "unexpected upstream headlamp sha" >&2
  exit 1
fi

sh "$SCRIPT_DIR/apply-upstream-patches.sh" "$WORK_DIR"

cd "$WORK_DIR/backend"
go test ./cmd -run 'Test(GetOrCreateConnection|EstablishClusterConnection|GetOrCreateConnection_HTTPWatchStream|Reconnect|Reconnect_WithToken)'
