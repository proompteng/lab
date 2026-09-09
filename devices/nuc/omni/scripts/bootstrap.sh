#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

require_command docker
require_command gpg
require_command install
require_command sudo
require_command tailscale
require_command uuidgen

[[ "$(uname -s)" == 'Linux' ]] || die 'Omni must be bootstrapped on the Linux NUC'
[[ "$(uname -m)" == 'x86_64' ]] || die 'the pinned images require an x86_64 NUC'
[[ -c /dev/net/tun ]] || die '/dev/net/tun is unavailable'
docker compose version >/dev/null
tailscale ip -4 >/dev/null

umask 077

if [[ ! -e "${OMNI_ENV_FILE}" ]]; then
  install -m 0600 "${OMNI_DIR}/.env.example" "${OMNI_ENV_FILE}"
  account_uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')
  sed -i "s/^OMNI_ACCOUNT_UUID=$/OMNI_ACCOUNT_UUID=${account_uuid}/" "${OMNI_ENV_FILE}"
  printf 'created %s with a persistent Omni account UUID\n' "${OMNI_ENV_FILE}"
fi

chmod 0600 "${OMNI_ENV_FILE}"
load_omni_env

owner=${SUDO_USER:-${USER}}
group=$(id -gn "${owner}")
for directory in "${OMNI_DATA_ROOT}" "${OMNI_DATA_ROOT}/backups" "${OMNI_DATA_ROOT}/etcd" \
  "${OMNI_DATA_ROOT}/secrets" "${OMNI_DATA_ROOT}/sqlite" "${OMNI_DATA_ROOT}/tsidp"; do
  sudo install -d -m 0700 -o "${owner}" -g "${group}" "${directory}"
done
ensure_cluster_etcd_backup_directory

key_path="${OMNI_DATA_ROOT}/secrets/omni.asc"
if [[ ! -s "${key_path}" ]]; then
  gpg_home=$(mktemp -d)
  cleanup() {
    rm -rf -- "${gpg_home}"
  }
  trap cleanup EXIT

  chmod 0700 "${gpg_home}"
  identity='Omni etcd encryption (proompteng lab) <omni-etcd@proompteng.invalid>'
  gpg --homedir "${gpg_home}" --batch --passphrase '' --quick-generate-key "${identity}" rsa4096 cert never
  fingerprint=$(gpg --homedir "${gpg_home}" --batch --with-colons --list-secret-keys "${identity}" |
    awk -F: '$1 == "fpr" { print $10; exit }')
  [[ -n "${fingerprint}" ]] || die 'failed to determine the generated GPG fingerprint'
  gpg --homedir "${gpg_home}" --batch --passphrase '' --quick-add-key "${fingerprint}" rsa4096 encr never
  gpg --homedir "${gpg_home}" --batch --export-secret-key --armor "${identity}" >"${gpg_home}/omni.asc"
  install -m 0600 "${gpg_home}/omni.asc" "${key_path}"
  printf 'created Omni etcd encryption key at %s\n' "${key_path}"
fi

chmod 0600 "${key_path}"

printf '\nBootstrap complete. Fill OMNI_ADMIN_EMAIL and TSIDP_AUTH_KEY in %s, then run:\n' "${OMNI_ENV_FILE}"
printf '  %s/scripts/bootstrap-tsidp.sh\n' "${OMNI_DIR}"
