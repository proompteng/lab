#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in curl docker jq ss tailscale; do
  require_command "${command}"
done

load_omni_env

require_https_endpoint() {
  local name=$1
  local url=$2
  local status

  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${url}") ||
    die "${name} is not reachable at ${url}"
  [[ "${status}" =~ ^[1-4][0-9]{2}$ ]] || die "${name} returned HTTP ${status} at ${url}"
}

for service in tsidp omni; do
  container_id=$(compose ps --quiet "${service}")
  [[ -n "${container_id}" ]] || die "${service} container does not exist"
  [[ "$(docker inspect --format '{{.State.Status}}' "${container_id}")" == 'running' ]] || die "${service} is not running"
done

curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8180/
require_https_endpoint 'Omni UI/API' "https://${OMNI_HOST}/"
require_https_endpoint 'Omni machine API' "https://${OMNI_HOST}:8090/"
require_https_endpoint 'Omni Kubernetes proxy' "https://${OMNI_HOST}:8100/"
curl --fail --silent --show-error --output /dev/null \
  "${OIDC_ISSUER_URL}/.well-known/openid-configuration"

ss -H -lunp | grep -Fq "${NUC_TAILSCALE_IP}:50180" || die 'Omni is not listening for SideroLink WireGuard on the NUC tail IP'

current=$(mktemp)
expected=$(mktemp)
cleanup() {
  rm -f -- "${current}" "${expected}"
}
trap cleanup EXIT
tailscale serve get-config --all | jq --sort-keys . >"${current}"
jq --sort-keys . "${OMNI_DIR}/tailscale-serve.json" >"${expected}"
cmp --silent "${current}" "${expected}" || die 'Tailscale Serve configuration drifted'

printf 'Omni runtime verification passed\n'
printf 'Open https://%s/ and complete the EULA as the named user; this deployment does not accept it for you.\n' "${OMNI_HOST}"
