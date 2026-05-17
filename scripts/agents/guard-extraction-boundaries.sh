#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
ARGO_DIR="${ROOT_DIR}/argocd/applications/agents"

fail_if_matches() {
  local description="$1"
  local pattern="$2"
  shift 2

  if rg -n "${pattern}" "$@"; then
    echo "Agents extraction boundary violation: ${description}" >&2
    exit 1
  fi
}

fail_if_matches \
  "services/agents must not import or package Jangar-local runner paths" \
  'services/jangar|/app/services/jangar|codex-implement' \
  "${ROOT_DIR}/services/agents"

rendered_chart="$(mktemp)"
rendered_argo="$(mktemp)"
cleanup() {
  rm -f "${rendered_chart}" "${rendered_argo}"
}
trap cleanup EXIT

helm template agents "${CHART_DIR}" --namespace agents > "${rendered_chart}"
kubectl kustomize "${ARGO_DIR}" --enable-helm > "${rendered_argo}"

rendered_forbidden='JANGAR_|jangar-db-app|/etc/jangar|lab/jangar|/app/services/jangar|services/jangar|codex-implement'
fail_if_matches "rendered Helm chart must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_chart}"
fail_if_matches "rendered Agents GitOps app must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_argo}"
