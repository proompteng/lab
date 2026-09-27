#!/usr/bin/env bash
set -euo pipefail
state="${1:?Persistent state directory required}"
active="${2:?Active root digest required}"
[[ "$active" =~ ^[a-f0-9]{64}$ && -f "$state/roots/$active/.image-complete" ]] || exit 1
previous=''
if [[ -f "$state/metadata/last-ready" ]]; then
  previous="$(cat "$state/metadata/last-ready")"
  [[ "$previous" =~ ^[a-f0-9]{64}$ ]]
fi
for generation in "$state/roots"/* "$state/roots"/.extract.*; do
  [[ -d "$generation" && ! -L "$generation" ]] || continue
  name="${generation##*/}"
  [[ "$name" != "$active" && "$name" != "$previous" ]] || continue
  if [[ "$name" =~ ^[a-f0-9]{64}$ || "$name" == .extract.* ]]; then
    rm -rf -- "$generation"
  fi
done
