#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in curl find seq; do
  require_command "${command}"
done

"${SCRIPT_DIR}/validate.sh" bootstrap
load_omni_env

if [[ -z "$(find "${OMNI_DATA_ROOT}/tsidp" -mindepth 1 -print -quit)" ]]; then
  require_env_value TSIDP_AUTH_KEY
fi

compose pull tsidp
compose up -d tsidp

for _ in $(seq 1 45); do
  if curl --fail --silent --show-error --output /dev/null \
    "${OIDC_ISSUER_URL}/.well-known/openid-configuration"; then
    printf 'tsidp is ready at %s\n' "${OIDC_ISSUER_URL}"
    printf 'Create the Omni client with redirect URI https://%s/oidc/consume\n' "${OMNI_HOST}"
    printf 'Then set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in %s and clear TSIDP_AUTH_KEY.\n' "${OMNI_ENV_FILE}"
    exit 0
  fi

  sleep 2
done

compose logs --tail 40 tsidp >&2
die 'tsidp did not become reachable within 90 seconds'
