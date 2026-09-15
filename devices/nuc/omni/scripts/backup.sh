#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in awk df du flock grep sha256sum sudo tar; do
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
checksum="${archive}.sha256"
temporary="${archive}.tmp"
checksum_temporary="${checksum}.tmp"
contents_temporary="${archive}.contents.tmp"
backup_complete=false
omni_was_running=false
tsidp_was_running=false
minimum_free_bytes=${OMNI_BACKUP_MIN_FREE_BYTES:-10737418240}

exec 9>"${OMNI_DATA_ROOT}/backups/.backup.lock"
chmod 0600 "${OMNI_DATA_ROOT}/backups/.backup.lock"
flock --nonblock 9 || die 'another Omni full-state backup is already running'
[[ "${minimum_free_bytes}" =~ ^[0-9]+$ ]] || die 'OMNI_BACKUP_MIN_FREE_BYTES must contain only decimal digits'
[[ ! -e "${archive}" && ! -e "${checksum}" && ! -e "${temporary}" && ! -e "${checksum_temporary}" ]] ||
  die "backup output already exists for timestamp ${timestamp}"

archive_paths=(
  "${data_root_relative}/etcd"
  "${data_root_relative}/cluster-etcd-backups"
  "${data_root_relative}/sqlite"
  "${data_root_relative}/tsidp"
  "${data_root_relative}/secrets"
  "${omni_dir_relative}/.env"
)
source_bytes=$(sudo du --summarize --bytes "${archive_paths[@]/#//}" | awk '{ total += $1 } END { print total + 0 }')
free_bytes=$(df --output=avail --block-size=1 "${OMNI_DATA_ROOT}" | awk 'NR == 2 { print $1 }')
[[ "${source_bytes}" =~ ^[0-9]+$ && "${free_bytes}" =~ ^[0-9]+$ ]] || die 'failed to measure backup disk space'
required_free_bytes=$((source_bytes + minimum_free_bytes))
((free_bytes >= required_free_bytes)) ||
  die "insufficient disk space: need ${required_free_bytes} bytes, have ${free_bytes} bytes"
printf 'backup preflight source_bytes=%s free_bytes=%s reserve_bytes=%s\n' \
  "${source_bytes}" "${free_bytes}" "${minimum_free_bytes}"

[[ "$(compose ps --status running --quiet omni)" == "$(compose ps --quiet omni)" && -n "$(compose ps --quiet omni)" ]] &&
  omni_was_running=true
[[ "$(compose ps --status running --quiet tsidp)" == "$(compose ps --quiet tsidp)" && -n "$(compose ps --quiet tsidp)" ]] &&
  tsidp_was_running=true

restart_services() {
  sudo rm -f -- "${temporary}" "${contents_temporary}" 2>/dev/null || true
  rm -f -- "${checksum_temporary}"
  if [[ "${backup_complete}" != true ]]; then
    rm -f -- "${archive}" "${checksum}"
  fi
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
  "${archive_paths[@]}"
sudo chown "$(id -u):$(id -g)" "${temporary}"
chmod 0600 "${temporary}"
tar --list --gzip --file "${temporary}" >"${contents_temporary}"
for required_path in "${archive_paths[@]}"; do
  grep --fixed-strings --quiet "${required_path}" "${contents_temporary}" ||
    die "backup archive is missing required path: ${required_path}"
done

archive_hash=$(sha256sum "${temporary}" | awk '{ print $1 }')
[[ "${archive_hash}" =~ ^[0-9a-f]{64}$ ]] || die 'failed to calculate backup checksum'
printf '%s  %s\n' "${archive_hash}" "${temporary}" | sha256sum --check --status
printf '%s  %s\n' "${archive_hash}" "${archive##*/}" >"${checksum_temporary}"
chmod 0600 "${checksum_temporary}"
mv -- "${checksum_temporary}" "${checksum}"
mv -- "${temporary}" "${archive}"
(cd "${OMNI_DATA_ROOT}/backups" && sha256sum --check "${checksum##*/}")
backup_complete=true

restart_services
trap - EXIT
printf 'created offline Omni backup %s\n' "${archive}"
printf 'created checksum %s\n' "${checksum}"
printf 'copy the archive and checksum to encrypted off-host storage\n'
