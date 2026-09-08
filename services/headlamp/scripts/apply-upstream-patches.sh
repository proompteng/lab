#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <headlamp-source-dir>" >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
PATCH_DIR="${SCRIPT_DIR%/scripts}/patches"
TARGET_DIR="$1"

for patch in "$PATCH_DIR"/*.patch; do
  [ -e "$patch" ] || continue
  git -C "$TARGET_DIR" apply "$patch"
done
