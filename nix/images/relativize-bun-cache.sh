#!/usr/bin/env bash
set -euo pipefail

cache="${1:?Bun cache directory is required}"
source_cache="${2:?original Bun cache directory is required}"
test -d "${cache}"

# Bun's version aliases point into its original cache. Keep copied caches
# independent of the temporary build directory and usable after relocation.
while IFS= read -r -d '' link; do
  target="$(readlink -- "${link}")"
  case "${target}" in
    "${source_cache}"/*)
      ln --symbolic --force --relative --no-target-directory -- "${cache}/${target#"${source_cache}"/}" "${link}"
      ;;
  esac
done < <(find "${cache}" -type l -print0)
