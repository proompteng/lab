#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in sha256sum sudo tar; do
  require_command "${command}"
done

load_omni_env
ensure_cluster_etcd_backup_directory

[[ "${OMNI_DIR}" == /* ]] || die 'OMNI_DIR must be absolute'
[[ "${OMNI_DATA_ROOT}" == /* ]] || die 'OMNI_DATA_ROOT must be absolute'

omni_dir_relative=${OMNI_DIR#/}
data_root_relative=${OMNI_DATA_ROOT#/}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="${OMNI_DATA_ROOT}/backups/omni-${timestamp}.tar.gz"
temporary="${archive}.tmp"
omni_was_running=false
tsidp_was_running=false

[[ "$(compose ps --status running --quiet omni)" == "$(compose ps --quiet omni)" && -n "$(compose ps --quiet omni)" ]] &&
  omni_was_running=true
[[ "$(compose ps --status running --quiet tsidp)" == "$(compose ps --quiet tsidp)" && -n "$(compose ps --quiet tsidp)" ]] &&
  tsidp_was_running=true

restart_services() {
  sudo rm -f -- "${temporary}" 2>/dev/null || true
  if [[ "${tsidp_was_running}" == true ]]; then
    compose up -d tsidp >/dev/null
  fi
  if [[ "${omni_was_running}" == true ]]; then
    compose up -d omni >/dev/null
  fi
}
trap restart_services EXIT

compose stop --timeout 60 omni tsidp
sudo tar --numeric-owner --create --gzip --file "${temporary}" \
  --directory / \
  "${data_root_relative}/etcd" \
  "${data_root_relative}/cluster-etcd-backups" \
  "${data_root_relative}/sqlite" \
  "${data_root_relative}/tsidp" \
  "${data_root_relative}/secrets" \
  "${omni_dir_relative}/.env"
sudo chown "$(id -u):$(id -g)" "${temporary}"
chmod 0600 "${temporary}"
mv -- "${temporary}" "${archive}"
sha256sum "${archive}" >"${archive}.sha256"
chmod 0600 "${archive}.sha256"

trap - EXIT
restart_services
printf 'created offline Omni backup %s\n' "${archive}"
printf 'copy the archive and checksum to encrypted off-host storage\n'
