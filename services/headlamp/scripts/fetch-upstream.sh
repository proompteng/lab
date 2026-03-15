#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <destination-dir>" >&2
  exit 1
fi

DEST_DIR="$1"
HEADLAMP_REF="${HEADLAMP_REF:-v0.40.1}"
HEADLAMP_SHA="${HEADLAMP_SHA:-434a12263a6bd9d25f86f8bfa00d9992ac2672e3}"

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

git init "$DEST_DIR" >/dev/null
git -C "$DEST_DIR" remote add origin https://github.com/kubernetes-sigs/headlamp.git
git -C "$DEST_DIR" fetch --depth 1 origin "$HEADLAMP_REF" >/dev/null
git -C "$DEST_DIR" checkout --detach FETCH_HEAD >/dev/null

if [ "$(git -C "$DEST_DIR" rev-parse HEAD)" != "$HEADLAMP_SHA" ]; then
  echo "unexpected upstream headlamp sha" >&2
  exit 1
fi

printf '%s\n' "$HEADLAMP_SHA" > "$DEST_DIR/.codex-upstream-sha"
