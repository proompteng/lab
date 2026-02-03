#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CLUSTER_NAME="${CLUSTER_NAME:-agents}"
NAMESPACE="${NAMESPACE:-agents}"
POSTGRES_RELEASE="${POSTGRES_RELEASE:-agents-postgres}"
POSTGRES_USER="${POSTGRES_USER:-agents}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agents}"
POSTGRES_DB="${POSTGRES_DB:-agents}"
CHART_PATH="${CHART_PATH:-${REPO_ROOT}/charts/agents}"
VALUES_FILE="${VALUES_FILE:-${CHART_PATH}/values-kind.yaml}"
SECRET_NAME="${SECRET_NAME:-jangar-db-app}"
SECRET_KEY="${SECRET_KEY:-uri}"
KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-kind-${CLUSTER_NAME}}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-jangar-local}"
IMAGE_TAG="${IMAGE_TAG:-kind}"
BUILD_IMAGE="${BUILD_IMAGE:-1}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd kind
require_cmd kubectl
require_cmd helm
require_cmd docker
require_cmd bun
require_cmd bunx
require_cmd git

if ! kind get clusters | grep -qx "${CLUSTER_NAME}"; then
  echo "Creating kind cluster ${CLUSTER_NAME}"
  kind create cluster --name "${CLUSTER_NAME}"
else
  echo "Kind cluster ${CLUSTER_NAME} already exists"
fi

kubectl config use-context "${KUBECTL_CONTEXT}" >/dev/null

kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

if [ "${BUILD_IMAGE}" = "1" ]; then
  echo "Building Jangar image ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
  PRUNE_DIR="$(mktemp -d /tmp/jangar-prune-XXXXXX)"
  cleanup_prune() {
    rm -rf "${PRUNE_DIR}"
  }
  trap cleanup_prune EXIT

  OUTPUT_ENTRY="${REPO_ROOT}/services/jangar/.output/server/index.mjs"
  OUTPUT_PROTO="${REPO_ROOT}/services/jangar/.output/server/proto/proompteng/jangar/v1/agentctl.proto"
  BUILD_OUTPUT=0
  if [ ! -f "${OUTPUT_ENTRY}" ] || [ ! -f "${OUTPUT_PROTO}" ]; then
    BUILD_OUTPUT=1
  fi

  bunx turbo prune --scope=@proompteng/jangar --docker --out-dir="${PRUNE_DIR}"
  cp "${REPO_ROOT}/tsconfig.base.json" "${PRUNE_DIR}/tsconfig.base.json"
  if [ -d "${REPO_ROOT}/skills" ]; then
    cp -R "${REPO_ROOT}/skills" "${PRUNE_DIR}/skills"
  fi

  if [ -d "${REPO_ROOT}/services/jangar/agentctl" ]; then
    mkdir -p "${PRUNE_DIR}/full/services/jangar" "${PRUNE_DIR}/json/services/jangar"
    cp -R "${REPO_ROOT}/services/jangar/agentctl" "${PRUNE_DIR}/full/services/jangar/agentctl"
    cp -R "${REPO_ROOT}/services/jangar/agentctl" "${PRUNE_DIR}/json/services/jangar/agentctl"
  fi

  OUTPUT_SOURCE="${REPO_ROOT}/services/jangar/.output"
  if [ "${BUILD_OUTPUT}" = "1" ]; then
    echo "Building services/jangar .output in pruned context"
    BUILD_DIR="${PRUNE_DIR}/build"
    mkdir -p "${BUILD_DIR}"
    cp -R "${PRUNE_DIR}/json/." "${BUILD_DIR}/"
    cp "${PRUNE_DIR}/tsconfig.base.json" "${BUILD_DIR}/tsconfig.base.json"
    (cd "${BUILD_DIR}" && bun install --no-save --ignore-scripts)
    cp -R "${PRUNE_DIR}/full/." "${BUILD_DIR}/"
    (cd "${BUILD_DIR}/services/jangar" && bun run build)
    mkdir -p "${PRUNE_DIR}/full/services/jangar"
    cp -R "${BUILD_DIR}/services/jangar/.output" "${PRUNE_DIR}/full/services/jangar/.output"
  elif [ -f "${OUTPUT_ENTRY}" ] && [ -f "${OUTPUT_PROTO}" ]; then
    mkdir -p "${PRUNE_DIR}/full/services/jangar"
    cp -R "${OUTPUT_SOURCE}" "${PRUNE_DIR}/full/services/jangar/.output"
  elif [ -d "${OUTPUT_SOURCE}" ]; then
    echo "Skipping prebuilt .output: missing ${OUTPUT_ENTRY} or ${OUTPUT_PROTO}"
  fi

  CODEX_AUTH_PATH="${CODEX_AUTH_PATH:-${HOME}/.codex/auth.json}"
  if [ ! -f "${CODEX_AUTH_PATH}" ]; then
    CODEX_AUTH_PATH="${PRUNE_DIR}/codex-auth.json"
    printf '{}' > "${CODEX_AUTH_PATH}"
  fi

  JANGAR_VERSION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
  JANGAR_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"

  DOCKER_BUILDKIT=1 docker build \
    -f "${REPO_ROOT}/services/jangar/Dockerfile" \
    -t "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
    --build-arg "JANGAR_VERSION=${JANGAR_VERSION}" \
    --build-arg "JANGAR_COMMIT=${JANGAR_COMMIT}" \
    --secret "id=codexauth,src=${CODEX_AUTH_PATH}" \
    "${PRUNE_DIR}"
fi

echo "Loading image into kind cluster"
kind load docker-image "${IMAGE_REPOSITORY}:${IMAGE_TAG}" --name "${CLUSTER_NAME}"

helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install "${POSTGRES_RELEASE}" bitnami/postgresql \
  --namespace "${NAMESPACE}" \
  --set auth.username="${POSTGRES_USER}" \
  --set auth.password="${POSTGRES_PASSWORD}" \
  --set auth.database="${POSTGRES_DB}" \
  --set primary.persistence.enabled=false \
  --set fullnameOverride="${POSTGRES_RELEASE}" \
  --wait

kubectl -n "${NAMESPACE}" rollout status statefulset "${POSTGRES_RELEASE}" --timeout=180s

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_RELEASE}.${NAMESPACE}.svc.cluster.local:5432/${POSTGRES_DB}?sslmode=disable"

kubectl -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
  --from-literal="${SECRET_KEY}=${DATABASE_URL}" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install agents "${CHART_PATH}" \
  --namespace "${NAMESPACE}" \
  --values "${VALUES_FILE}" \
  --set image.repository="${IMAGE_REPOSITORY}" \
  --set image.tag="${IMAGE_TAG}"

kubectl -n "${NAMESPACE}" rollout status deployment/agents --timeout=180s

kubectl -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/agentprovider-smoke.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/agent-smoke.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/implementationspec-smoke.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/agentrun-workflow-smoke.yaml"

kubectl -n "${NAMESPACE}" wait --for=condition=Succeeded agentrun/agents-workflow-smoke --timeout=300s

kubectl -n "${NAMESPACE}" get agentruns agents-workflow-smoke -o wide

cat <<'OUT'

Agents chart kind run complete.

Next steps:
- Port-forward the control plane: kubectl -n agents port-forward svc/agents 8080:80
- Inspect AgentRun details: kubectl -n agents describe agentrun agents-workflow-smoke
- List Jobs created by the controller: kubectl -n agents get jobs
OUT
