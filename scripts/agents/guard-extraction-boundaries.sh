#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
ARGO_DIR="${ROOT_DIR}/argocd/applications/agents"

fail_if_matches() {
  local description="$1"
  local pattern="$2"
  shift 2

  if rg -n \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.*' \
    --glob '!guard-extraction-boundaries.sh' \
    "${pattern}" \
    "$@"; then
    echo "Agents extraction boundary violation: ${description}" >&2
    exit 1
  fi
}

fail_if_matches \
  "services/agents must not import or package Jangar-local runner paths" \
  'services/jangar|/app/services/jangar|codex-implement' \
  "${ROOT_DIR}/services/agents/src" \
  "${ROOT_DIR}/services/agents/package.json" \
  "${ROOT_DIR}/services/agents/Dockerfile" \
  "${ROOT_DIR}/services/agents/Dockerfile.codex-runner"

fail_if_matches \
  "Agents build and CI entrypoints must not call the Jangar Dockerfile or Jangar image builder" \
  'services/jangar/Dockerfile|\.\./jangar/build-image' \
  "${ROOT_DIR}/.github/workflows/agents-build-push.yml" \
  "${ROOT_DIR}/.github/workflows/agents-ci.yml" \
  "${ROOT_DIR}/scripts/agents" \
  "${ROOT_DIR}/packages/scripts/src/agents"

fail_if_matches \
  "Jangar GitOps must not own Codex run-complete ingestion" \
  'uri: /api/codex/run-complete|name: jangar-codex-completions' \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Facteur, Froussard, and shared Argo GitOps must not use the legacy codex-universal runtime" \
  'codex-universal|/usr/local/bin/codex-bootstrap|ghcr.io/openai/codex-universal' \
  "${ROOT_DIR}/argocd/applications/facteur" \
  "${ROOT_DIR}/argocd/applications/froussard" \
  "${ROOT_DIR}/argocd/applications/argo-workflows"

fail_if_matches \
  "Froussard GitOps must not ship legacy Codex implementation WorkflowTemplates" \
  'github-codex-implementation-workflow-template|codex-run-workflow-template-jangar|codex-autonomous-workflow-template|github-codex-post-deploy-workflow-template' \
  "${ROOT_DIR}/argocd/applications/froussard"

rendered_chart="$(mktemp)"
rendered_argo="$(mktemp)"
cleanup() {
  rm -f "${rendered_chart}" "${rendered_argo}"
}
trap cleanup EXIT

helm template agents "${CHART_DIR}" --namespace agents > "${rendered_chart}"
kubectl kustomize "${ARGO_DIR}" --enable-helm > "${rendered_argo}"

rendered_forbidden='JANGAR_|jangar-db-app|/etc/jangar|lab/jangar|/app/services/jangar|services/jangar|codex-implement|AGENTS_TORGHUT_STATUS_|AGENTS_WHITEPAPER_FINALIZE_'
agents_runtime_forbidden='codex-universal|ghcr.io/openai/codex-universal'
fail_if_matches "rendered Helm chart must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_chart}"
fail_if_matches "rendered Agents GitOps app must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_argo}"
fail_if_matches "rendered Agents GitOps app must use the chart-managed agents-codex-runner path" "${agents_runtime_forbidden}" "${rendered_argo}"
