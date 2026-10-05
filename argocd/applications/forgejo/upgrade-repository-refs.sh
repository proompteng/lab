#!/usr/bin/env bash
set -euo pipefail

root=${1:?repository root required}
[[ -d "$root" ]] || exit 1
shopt -s nullglob
for repo in "$root"/*/*.git; do
  [[ -d "$repo" ]] || exit 1
  [[ $(git --git-dir="$repo" rev-parse --is-bare-repository) == true ]] || exit 1
  printf '%s\n' "$repo"
  if git --git-dir="$repo" show-ref; then
    continue
  else
    # A valid empty repository has no references and returns 1. Other failures
    # must not be confused with an empty repository.
    status=$?
    [[ "$status" == 1 ]] || exit "$status"
  fi
done
