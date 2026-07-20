#!/usr/bin/env bash

set -euo pipefail

readonly namespace=hermes
readonly lease=hermes-maintenance
readonly action="${1:-}"
readonly holder="${2:-}"

if [[ ! "$action" =~ ^(acquire|release|recover)$ ]] || [[ ! "$holder" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || (( $# != 2 )); then
  echo 'usage: maintenance-lock.sh <acquire|release|recover> <holder>' >&2
  exit 2
fi

patch_holder() {
  local expected_holder="$1"
  local replacement_holder="$2"
  local now patch
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  patch="$(
    jq -cn --arg expected "$expected_holder" --arg replacement "$replacement_holder" --arg now "$now" \
      '[
        {op: "test", path: "/spec/holderIdentity", value: $expected},
        {op: "replace", path: "/spec/holderIdentity", value: $replacement},
        {op: "add", path: "/spec/renewTime", value: $now}
      ]'
  )"
  kubectl -n "$namespace" patch lease "$lease" --type=json -p "$patch" >/dev/null
}

current_holder() {
  kubectl -n "$namespace" get lease "$lease" -o jsonpath='{.spec.holderIdentity}'
}

case "$action" in
  acquire)
    if ! patch_holder '' "$holder"; then
      echo 'Hermes maintenance Lease is already held' >&2
      exit 1
    fi
    ;;
  release)
    observed_holder="$(current_holder)"
    if [[ -z "$observed_holder" ]]; then
      exit 0
    fi
    if [[ "$observed_holder" != "$holder" ]]; then
      echo 'refusing to release a Hermes maintenance Lease held by another operator' >&2
      exit 1
    fi
    patch_holder "$holder" ''
    ;;
  recover)
    bash "$(dirname "$0")/wait-for-maintenance.sh"
    if [[ "$(current_holder)" != "$holder" ]]; then
      echo 'Hermes maintenance Lease holder changed during recovery' >&2
      exit 1
    fi
    patch_holder "$holder" ''
    ;;
esac
