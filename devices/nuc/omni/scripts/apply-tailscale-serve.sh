#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in jq tailscale; do
  require_command "${command}"
done

load_omni_env
require_env_value OMNI_HOST
[[ "${OMNI_HOST}" == 'nuc.ide-newton.ts.net' ]] || die 'OMNI_HOST does not match tailscale-serve.json'

current=$(mktemp)
normalized_current=$(mktemp)
normalized_expected=$(mktemp)
cleanup() {
  rm -f -- "${current}" "${normalized_current}" "${normalized_expected}"
}
trap cleanup EXIT

tailscale serve get-config --all >"${current}"
jq --sort-keys . "${current}" >"${normalized_current}"
jq --sort-keys . "${OMNI_DIR}/tailscale-serve.json" >"${normalized_expected}"

if cmp --silent "${normalized_current}" "${normalized_expected}"; then
  printf 'Tailscale Serve configuration is already current\n'
  exit 0
fi

if ! jq --exit-status 'keys == ["version"] and .version == "0.0.1"' "${current}" >/dev/null; then
  [[ "${OMNI_SERVE_REPLACE:-}" == '1' ]] ||
    die 'Tailscale Serve has unmanaged configuration; review it and rerun with OMNI_SERVE_REPLACE=1'
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
install -m 0600 "${current}" "${OMNI_DATA_ROOT}/backups/tailscale-serve-before-${timestamp}.json"
tailscale serve set-config --all "${OMNI_DIR}/tailscale-serve.json"

tailscale serve get-config --all >"${current}"
jq --sort-keys . "${current}" >"${normalized_current}"
cmp --silent "${normalized_current}" "${normalized_expected}" || die 'Tailscale Serve did not retain the expected configuration'
printf 'Tailscale Serve now exposes Omni privately at https://%s/\n' "${OMNI_HOST}"
