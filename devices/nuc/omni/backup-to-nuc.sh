#!/usr/bin/env bash

set -Eeuo pipefail

NUC_SSH_TARGET=${NUC_SSH_TARGET:-kalmyk@nuc.ide-newton.ts.net}
NUC_OMNI_DIR=${NUC_OMNI_DIR:-/home/kalmyk/omni}
OMNI_CONTEXT=${OMNI_CONTEXT:-default}
OMNI_BACKUP_TIMEOUT_SECONDS=${OMNI_BACKUP_TIMEOUT_SECONDS:-900}
OMNI_BACKUP_POLL_SECONDS=${OMNI_BACKUP_POLL_SECONDS:-5}
cluster_name=${1:-galactic}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

run_on_nuc() {
  local remote_command

  printf -v remote_command '%q ' "$@"
  # Each argument is shell-escaped above before SSH passes the command to the remote shell.
  # shellcheck disable=SC2029
  ssh "${NUC_SSH_TARGET}" "${remote_command% }"
}

[[ $# -le 1 ]] || die 'usage: backup-to-nuc.sh [cluster-name]'
[[ "${cluster_name}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || die 'cluster name contains unsupported characters'
[[ "${NUC_SSH_TARGET}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$ ]] ||
  die 'NUC_SSH_TARGET contains unsupported characters'
[[ "${NUC_OMNI_DIR}" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'NUC_OMNI_DIR must be a safe absolute path'
[[ "${OMNI_CONTEXT}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die 'OMNI_CONTEXT contains unsupported characters'
[[ "${OMNI_BACKUP_TIMEOUT_SECONDS}" =~ ^[0-9]+$ && "${OMNI_BACKUP_TIMEOUT_SECONDS}" -gt 0 ]] ||
  die 'OMNI_BACKUP_TIMEOUT_SECONDS must be a positive integer'
[[ "${OMNI_BACKUP_POLL_SECONDS}" =~ ^[0-9]+$ && "${OMNI_BACKUP_POLL_SECONDS}" -gt 0 ]] ||
  die 'OMNI_BACKUP_POLL_SECONDS must be a positive integer'

for command in date jq mktemp omnictl seq sleep ssh; do
  command -v "${command}" >/dev/null 2>&1 || die "required command is missing: ${command}"
done

manifest=$(mktemp)
chmod 0600 "${manifest}"
cleanup() {
  rm -f -- "${manifest}"
}
trap cleanup EXIT

omni() {
  omnictl --context "${OMNI_CONTEXT}" "$@"
}

overall=$(omni get etcdbackupoverallstatus -o json)
configuration_name=$(jq --raw-output '.spec.configurationname // ""' <<<"${overall}")
configuration_error=$(jq --raw-output '.spec.configurationerror // ""' <<<"${overall}")
[[ "${configuration_name}" == 'local' ]] ||
  die "Omni backup backend must be local, found: ${configuration_name:-unconfigured}"
[[ -z "${configuration_error}" ]] || die "Omni backup backend is unhealthy: ${configuration_error}"

cluster_uuid_resource=$(omni get clusteruuid "${cluster_name}" -o json)
cluster_uuid=$(jq --raw-output '.spec.uuid // ""' <<<"${cluster_uuid_resource}")
[[ "${cluster_uuid}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
  die "Omni returned an invalid UUID for cluster ${cluster_name}"

status_resource=$(omni get etcdbackupstatus "${cluster_name}" -o json)
previous_backup_seconds=$(jq --raw-output '.spec.lastbackuptime.seconds // 0' <<<"${status_resource}")
[[ "${previous_backup_seconds}" =~ ^[0-9]+$ ]] || die 'Omni returned an invalid previous backup timestamp'

run_on_nuc "${NUC_OMNI_DIR}/scripts/verify.sh" >/dev/null
requested_at=$(run_on_nuc date +%s)
[[ "${requested_at}" =~ ^[0-9]+$ ]] || die 'NUC returned an invalid current timestamp'

jq --null-input \
  --arg cluster "${cluster_name}" \
  --argjson requestedAt "${requested_at}" \
  '{
    metadata: {
      namespace: "ephemeral",
      type: "EtcdManualBackups.omni.sidero.dev",
      id: $cluster
    },
    spec: {
      backupat: {
        seconds: $requestedAt,
        nanos: 0
      }
    }
  }' >"${manifest}"

printf 'requesting a fresh etcd backup for cluster %s\n' "${cluster_name}"
omni apply -f "${manifest}"

deadline=$((requested_at + OMNI_BACKUP_TIMEOUT_SECONDS))
completed_at=0
backup_succeeded=false
while :; do
  now=$(date +%s)
  ((now <= deadline)) || break

  status_resource=$(omni get etcdbackupstatus "${cluster_name}" -o json)
  status=$(jq --raw-output '.spec.status // 0' <<<"${status_resource}")
  error=$(jq --raw-output '.spec.error // ""' <<<"${status_resource}")
  last_attempt=$(jq --raw-output '.spec.lastbackupattempt.seconds // 0' <<<"${status_resource}")
  completed_at=$(jq --raw-output '.spec.lastbackuptime.seconds // 0' <<<"${status_resource}")

  [[ "${last_attempt}" =~ ^[0-9]+$ && "${completed_at}" =~ ^[0-9]+$ ]] ||
    die 'Omni returned an invalid backup status timestamp'
  if ((last_attempt >= requested_at)) && [[ -n "${error}" ]]; then
    die "Omni cluster backup failed: ${error}"
  fi
  if [[ "${status}" == '1' && -z "${error}" ]] &&
    ((completed_at >= requested_at && completed_at > previous_backup_seconds)); then
    backup_succeeded=true
    break
  fi

  sleep "${OMNI_BACKUP_POLL_SECONDS}"
done

[[ "${backup_succeeded}" == true ]] || die "timed out waiting for a fresh ${cluster_name} etcd backup"

run_on_nuc "${NUC_OMNI_DIR}/scripts/verify-cluster-backup.sh" \
  "${cluster_uuid}" "${requested_at}"
run_on_nuc "${NUC_OMNI_DIR}/scripts/backup.sh"

runtime_ready=false
for _ in $(seq 1 45); do
  if run_on_nuc "${NUC_OMNI_DIR}/scripts/verify.sh" >/dev/null 2>&1; then
    runtime_ready=true
    break
  fi

  sleep 2
done
[[ "${runtime_ready}" == true ]] || die 'Omni runtime did not recover after the full-state backup'
run_on_nuc "${NUC_OMNI_DIR}/scripts/verify.sh"

printf 'repeatable NUC backup completed for cluster %s at %s\n' "${cluster_name}" "${completed_at}"
