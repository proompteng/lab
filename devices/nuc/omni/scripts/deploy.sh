#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in curl seq; do
  require_command "${command}"
done

load_omni_env
ensure_cluster_etcd_backup_directory
"${SCRIPT_DIR}/validate.sh" full

curl --fail --silent --show-error --output /dev/null \
  "${OIDC_ISSUER_URL}/.well-known/openid-configuration" ||
  die 'tsidp is not ready; run scripts/bootstrap-tsidp.sh first'

compose pull
compose up -d tsidp omni

for _ in $(seq 1 45); do
  if curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8180/; then
    break
  fi

  sleep 2
done

curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8180/ || {
  compose logs --tail 80 omni >&2
  die 'Omni did not become reachable on its loopback endpoint'
}

"${SCRIPT_DIR}/apply-tailscale-serve.sh"
"${SCRIPT_DIR}/verify.sh"
