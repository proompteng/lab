#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s <app|bumba|froussard|oirat|signal-publisher> <x86_64-linux|aarch64-linux>\n' "$0" >&2
}

if [[ "$#" -ne 2 ]]; then
  usage
  exit 2
fi

service="$1"
case "${service}" in
  app | bumba | froussard | oirat | signal-publisher) ;;
  *)
    printf 'Unsupported Bun dependency-closure service: %s\n' "${service}" >&2
    exit 2
    ;;
esac

system="$2"
case "${system}" in
  x86_64-linux | aarch64-linux) ;;
  *)
    printf 'Unsupported Bun dependency-closure system: %s (native Linux only)\n' "${system}" >&2
    exit 2
    ;;
esac

for command_name in jq nix timeout; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    exit 2
  fi
done

flake_attr=".#packages.${system}.${service}-image"
derivation_json="$(nix derivation show -r "${flake_attr}")"

matching_derivations_json="$(jq -c --arg deps_name "${service}-bun-deps-0" '
  [(.derivations // .) | to_entries[] |
    select((.value.name // .value.env.name) == $deps_name)]
' <<<"${derivation_json}")"
matching_derivation_count="$(jq -r 'length' <<<"${matching_derivations_json}")"

if [[ "${matching_derivation_count}" -ne 1 ]]; then
  printf 'Expected exactly one %s-bun-deps-0 derivation for %s; found %s\n' \
    "${service}" "${system}" "${matching_derivation_count}" >&2
  exit 1
fi

deps_drv="$(jq -r '.[0].key' <<<"${matching_derivations_json}")"
if [[ "${deps_drv}" =~ ^[0-9a-z]{32}-${service}-bun-deps-0\.drv$ ]]; then
  deps_drv="/nix/store/${deps_drv}"
fi
if [[ "${deps_drv}" != /nix/store/*.drv ]]; then
  printf 'Selected Bun dependency derivation is not an absolute Nix store path: %s\n' "${deps_drv}" >&2
  exit 1
fi

outputs_json="$(jq -c '.[0].value.outputs | keys' <<<"${matching_derivations_json}")"
output_count="$(jq -r 'length' <<<"${outputs_json}")"
output_name="$(jq -r '.[0] // empty' <<<"${outputs_json}")"
if [[ "${output_count}" -ne 1 || "${output_name}" != out ]]; then
  printf 'Expected Bun dependency derivation to expose exactly one out output for %s; found: %s\n' \
    "${system}" "$(jq -r 'join(",")' <<<"${outputs_json}")" >&2
  exit 1
fi

output_ref="${deps_drv}^out"
printf 'Realizing Bun fixed-output dependency closure for %s (%s)\n' "${system}" "${output_ref}"
timeout --kill-after=30s "${NIX_BUN_FOD_TIMEOUT:-10m}" \
  nix build "${output_ref}" --no-link --print-build-logs

printf 'Recomputing Bun fixed-output dependency closure for %s (%s)\n' "${system}" "${output_ref}"

# --rebuild forces Nix to execute this fixed-output derivation even when its
# declared output already exists, then compares the resulting content hash.
# If the declared depsHash is stale, Nix fails with the specified and actual
# fixed-output hashes. The preceding realization supplies the comparison output.
timeout --kill-after=30s "${NIX_BUN_FOD_TIMEOUT:-10m}" \
  nix build "${output_ref}" --rebuild --no-link --print-build-logs

printf 'Bun fixed-output dependency closure verified for %s\n' "${system}"
