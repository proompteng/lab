#!/usr/bin/env bash

set -euo pipefail

readonly namespace=hermes
readonly selector='app.kubernetes.io/name=hermes,app.kubernetes.io/component in (migration,restore)'
readonly restore_stage_pod=hermes-restore-stage
readonly timeout_seconds="${HERMES_MAINTENANCE_WAIT_TIMEOUT_SECONDS:-1200}"

cleanup_restore_stage=false
if [[ "${1:-}" == '--cleanup-restore-stage' && "$#" == 1 ]]; then
  cleanup_restore_stage=true
elif (( $# != 0 )); then
  echo 'usage: wait-for-maintenance.sh [--cleanup-restore-stage]' >&2
  exit 2
fi

if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'HERMES_MAINTENANCE_WAIT_TIMEOUT_SECONDS must be a positive integer' >&2
  exit 2
fi

readonly deadline=$(( $(date +%s) + timeout_seconds ))

while true; do
  active_count="$({
    kubectl -n "$namespace" get jobs -l "$selector" -o json
  } | jq '[.items[] | select(any(.status.conditions[]?; .status == "True" and (.type == "Complete" or .type == "Failed")) | not)] | length')"

  if [[ "$active_count" == 0 ]]; then
    break
  fi

  if (( $(date +%s) >= deadline )); then
    kubectl -n "$namespace" get jobs -l "$selector" -o name >&2
    echo 'active Hermes migration or restore Job did not terminate' >&2
    exit 1
  fi

  sleep 10
done

if kubectl -n "$namespace" get pod "$restore_stage_pod" >/dev/null 2>&1; then
  if [[ "$cleanup_restore_stage" != true ]]; then
    echo 'Hermes restore staging Pod exists; retry restore with --cleanup-restore-stage' >&2
    exit 1
  fi
  kubectl -n "$namespace" delete pod "$restore_stage_pod" --wait=true --timeout=10m
fi
