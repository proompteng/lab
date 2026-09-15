#!/usr/bin/env bash
set -Eeuo pipefail

readonly context="${KUBE_CONTEXT:-galactic-tailscale}"
readonly namespace='microvm-demo'
readonly expected_name='firecracker-turin-microvm'

if ! kubectl --context "${context}" get namespace "${namespace}" >/dev/null 2>&1; then
  printf 'namespace already absent: %s\n' "${namespace}"
  exit 0
fi

actual_name="$(kubectl --context "${context}" get namespace "${namespace}" \
  --output jsonpath='{.metadata.labels.app\.kubernetes\.io/name}')"
readonly actual_name
if [[ "${actual_name}" != "${expected_name}" ]]; then
  printf 'refusing to delete namespace %s: expected app label %s, got %s\n' \
    "${namespace}" "${expected_name}" "${actual_name:-<missing>}" >&2
  exit 1
fi

kubectl --context "${context}" delete namespace "${namespace}" --wait=true --timeout=5m
