#!/usr/bin/env bash

set -Eeuo pipefail

OMNI_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OMNI_ENV_FILE="${OMNI_DIR}/.env"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

load_omni_env() {
  [[ -f "${OMNI_ENV_FILE}" ]] || die "${OMNI_ENV_FILE} is missing; run scripts/bootstrap.sh first"

  local mode
  mode=$(stat -c '%a' "${OMNI_ENV_FILE}")
  [[ "${mode}" == '600' ]] || die "${OMNI_ENV_FILE} must have mode 600 (current: ${mode})"

  set -a
  # shellcheck disable=SC1090
  source "${OMNI_ENV_FILE}"
  set +a

  : "${OMNI_DATA_ROOT:=/var/lib/omni}"
  [[ "${OMNI_DATA_ROOT}" == '/var/lib/omni' ]] || die 'OMNI_DATA_ROOT must be /var/lib/omni on this NUC'
}

require_env_value() {
  local name=$1
  [[ -n "${!name:-}" ]] || die "${name} must be set in ${OMNI_ENV_FILE}"
}

compose() {
  docker compose --project-directory "${OMNI_DIR}" --env-file "${OMNI_ENV_FILE}" -f "${OMNI_DIR}/compose.yaml" "$@"
}
