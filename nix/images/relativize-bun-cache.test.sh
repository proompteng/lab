#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fixture="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "${fixture}"' EXIT

for build in first second; do
  source_cache="${fixture}/${build}/build-cache"
  output_cache="${fixture}/${build}/output-cache"
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
  cp -R "${source_cache}/." "${output_cache}/"
  bash "${repo_root}/nix/images/relativize-bun-cache.sh" "${output_cache}" "${source_cache}"
  rm -rf "${source_cache}"
  test "$(cat "${output_cache}/demo/1.0.0@@@1/package.json")" = 'unscoped package'
  test "$(cat "${output_cache}/@fixture/demo/1.0.0@@@1/package.json")" = 'scoped package'
  test "$(readlink "${output_cache}/demo/relative")" = '../demo@1.0.0@@@1'
done

first_hash="$(nix hash path "${fixture}/first/output-cache")"
second_hash="$(nix hash path "${fixture}/second/output-cache")"
test "${first_hash}" = "${second_hash}"
printf 'Bun caches survive build-directory removal and have reproducible hashes\n'
