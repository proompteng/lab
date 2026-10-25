#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

for command in find sed sort sudo; do
  require_command "${command}"
done

load_omni_env

[[ $# -eq 2 ]] || die 'usage: verify-cluster-backup.sh <cluster-uuid> <not-before-unix-seconds>'
cluster_uuid=$1
not_before=$2

[[ "${cluster_uuid}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
  die 'cluster UUID is invalid'
[[ "${not_before}" =~ ^[0-9]+$ ]] || die 'not-before timestamp must contain only decimal digits'
threshold=$((not_before > 0 ? not_before - 1 : 0))

backup_dir="${OMNI_DATA_ROOT}/cluster-etcd-backups/${cluster_uuid}"
[[ -d "${backup_dir}" ]] || die "cluster backup directory is missing: ${backup_dir}"

latest=$(sudo find "${backup_dir}" -maxdepth 1 -type f -name '*.snapshot' -newermt "@${threshold}" \
  -printf '%T@|%s|%p\n' | sort --numeric-sort --reverse | sed -n '1p')
[[ -n "${latest}" ]] || die "no cluster snapshot newer than ${not_before} exists in ${backup_dir}"

partial=$(sudo find "${backup_dir}" -maxdepth 1 -type f \
  \( -name '*.tmp' -o -name '*.partial' -o -name '*.part' \) -print -quit)
[[ -z "${partial}" ]] || die "partial cluster backup remains on disk: ${partial}"

IFS='|' read -r modified_epoch size path <<<"${latest}"
[[ "${size}" =~ ^[0-9]+$ && "${size}" -gt 0 ]] || die "cluster snapshot is empty: ${path}"

printf 'verified cluster etcd snapshot %s\n' "${path}"
printf 'snapshot bytes=%s modified_epoch=%s\n' "${size}" "${modified_epoch}"
