#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fixture="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "${fixture}"' EXIT

for build in copied direct; do
  output_cache="${fixture}/${build}/output-cache"
  source_cache="${output_cache}"
  if [[ "${build}" == copied ]]; then
    source_cache="${fixture}/${build}/build-cache"
  fi
  mkdir -p \
    "${source_cache}/demo@1.0.0@@@1" \
    "${source_cache}/demo" \
    "${source_cache}/@fixture/demo@1.0.0@@@1" \
    "${source_cache}/@fixture/demo" \
    "${output_cache}"
  printf 'unscoped package\n' > "${source_cache}/demo@1.0.0@@@1/package.json"
  printf 'scoped package\n' > "${source_cache}/@fixture/demo@1.0.0@@@1/package.json"
  ln -s "${source_cache}/demo@1.0.0@@@1" "${source_cache}/demo/1.0.0@@@1"
  ln -s "${source_cache}/@fixture/demo@1.0.0@@@1" "${source_cache}/@fixture/demo/1.0.0@@@1"
  ln -s '../demo@1.0.0@@@1' "${source_cache}/demo/relative"
  if [[ "${build}" == copied ]]; then
    cp -R "${source_cache}/." "${output_cache}/"
  fi
  bash "${repo_root}/nix/images/relativize-bun-cache.sh" "${output_cache}" "${source_cache}"
  if [[ "${build}" == copied ]]; then
    rm -rf "${source_cache}"
  fi
  test "$(cat "${output_cache}/demo/1.0.0@@@1/package.json")" = 'unscoped package'
  test "$(cat "${output_cache}/@fixture/demo/1.0.0@@@1/package.json")" = 'scoped package'
  test "$(readlink "${output_cache}/demo/relative")" = '../demo@1.0.0@@@1'
done

copied_hash="$(nix hash path "${fixture}/copied/output-cache")"
direct_hash="$(nix hash path "${fixture}/direct/output-cache")"
test "${copied_hash}" = "${direct_hash}"
printf 'Copied and direct Bun caches resolve the same links and have identical hashes\n'
