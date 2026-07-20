#!/usr/bin/env bash

set -euo pipefail

readonly namespace=hermes
readonly selector='app.kubernetes.io/name=hermes,app.kubernetes.io/component in (migration,restore)'
readonly timeout_seconds="${HERMES_MAINTENANCE_WAIT_TIMEOUT_SECONDS:-1200}"

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
    exit 0
  fi

  if (( $(date +%s) >= deadline )); then
    kubectl -n "$namespace" get jobs -l "$selector" -o name >&2
    echo 'active Hermes migration or restore Job did not terminate' >&2
    exit 1
  fi

  sleep 10
done
