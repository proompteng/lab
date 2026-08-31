#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib.sh"

mode=${1:-full}
[[ "${mode}" == 'bootstrap' || "${mode}" == 'full' ]] || die 'usage: validate.sh [bootstrap|full]'

for command in docker gpg jq ss tailscale; do
  require_command "${command}"
done

load_omni_env
require_env_value NUC_TAILSCALE_IP
require_env_value OMNI_HOST
require_env_value OIDC_ISSUER_URL

[[ "${OMNI_HOST}" == 'nuc.ide-newton.ts.net' ]] || die 'OMNI_HOST does not match the checked-in Serve configuration'
[[ "${OIDC_ISSUER_URL}" == 'https://tsidp.ide-newton.ts.net' ]] || die 'OIDC_ISSUER_URL must use the private tsidp MagicDNS endpoint'

current_tail_ip=$(tailscale ip -4 | head -n 1)
[[ "${current_tail_ip}" == "${NUC_TAILSCALE_IP}" ]] ||
  die "NUC Tailscale IP drift: expected ${NUC_TAILSCALE_IP}, current ${current_tail_ip}"

[[ -s "${OMNI_DATA_ROOT}/secrets/omni.asc" ]] || die 'Omni encryption key is missing; run scripts/bootstrap.sh'
gpg --batch --show-keys "${OMNI_DATA_ROOT}/secrets/omni.asc" >/dev/null
cluster_backup_dir="${OMNI_DATA_ROOT}/cluster-etcd-backups"
[[ -d "${cluster_backup_dir}" ]] || die "cluster etcd backup directory is missing: ${cluster_backup_dir}"
[[ "$(stat -c '%a' "${cluster_backup_dir}")" == '700' ]] ||
  die "cluster etcd backup directory must have mode 700: ${cluster_backup_dir}"
[[ -w "${cluster_backup_dir}" ]] || die "cluster etcd backup directory is not writable: ${cluster_backup_dir}"
jq -e \
  '.version == "0.0.1" and .TCP["443"].HTTPS and .TCP["8090"].TCPForward == "127.0.0.1:8090" and .TCP["8100"].HTTPS' \
  "${OMNI_DIR}/tailscale-serve.json" >/dev/null

if [[ "${mode}" == 'full' ]]; then
  require_env_value OMNI_ACCOUNT_UUID
  require_env_value OMNI_ADMIN_EMAIL
  require_env_value OIDC_CLIENT_ID
  require_env_value OIDC_CLIENT_SECRET

  [[ "${OMNI_ACCOUNT_UUID}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
    die 'OMNI_ACCOUNT_UUID is not a lowercase UUID'
  [[ "${OMNI_ADMIN_EMAIL}" == *@*.* ]] || die 'OMNI_ADMIN_EMAIL is not an email address'
fi

compose config --quiet
compose config --format json | jq -e \
  --arg source "${cluster_backup_dir}" \
  '.services.omni.volumes[] | select(.type == "bind" and .source == $source and .target == "/var/lib/omni/cluster-etcd-backups")' \
  >/dev/null || die 'Omni Compose configuration does not persist the cluster etcd backup directory'

if [[ -z "$(compose ps --quiet omni 2>/dev/null)" ]]; then
  occupied=$(ss -H -lntup | awk '$5 ~ /:(8180|8090|8091|8092|8100|50180)$/ { print }')
  [[ -z "${occupied}" ]] || die "an Omni port is already occupied: ${occupied}"
fi

printf 'Omni %s validation passed\n' "${mode}"
