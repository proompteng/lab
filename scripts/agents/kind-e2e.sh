#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CLUSTER_NAME="${CLUSTER_NAME:-agents}"
NAMESPACE="${NAMESPACE:-agents}"
POSTGRES_RELEASE="${POSTGRES_RELEASE:-agents-postgres}"
POSTGRES_USER="${POSTGRES_USER:-agents}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agents}"
POSTGRES_DB="${POSTGRES_DB:-agents}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-pgvector/pgvector:pg18}"
CHART_PATH="${CHART_PATH:-${REPO_ROOT}/charts/agents}"
VALUES_FILE="${VALUES_FILE:-${CHART_PATH}/values-kind.yaml}"
SECRET_NAME="${SECRET_NAME:-agents-db-app}"
SECRET_KEY="${SECRET_KEY:-uri}"
KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-kind-${CLUSTER_NAME}}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-agents-control-plane-local}"
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
require_cmd python3

if ! kind get clusters | grep -qx "${CLUSTER_NAME}"; then
  echo "Creating kind cluster ${CLUSTER_NAME}"
  kind create cluster --name "${CLUSTER_NAME}"
else
  echo "Kind cluster ${CLUSTER_NAME} already exists"
fi

KUBECTL=(kubectl --context "${KUBECTL_CONTEXT}")
HELM=(helm --kube-context "${KUBECTL_CONTEXT}")

"${KUBECTL[@]}" create namespace "${NAMESPACE}" --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -

if [ "${BUILD_IMAGE}" = "1" ]; then
  echo "Building Agents image ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
  PRUNE_DIR="$(mktemp -d /tmp/jangar-prune-XXXXXX)"
  cleanup_prune() {
    rm -rf "${PRUNE_DIR}"
  }
  trap cleanup_prune EXIT

  OUTPUT_ENTRY="${REPO_ROOT}/services/jangar/.output/server/index.mjs"
  OUTPUT_PROTO="${REPO_ROOT}/services/jangar/.output/server/proto/proompteng/jangar/v1/agentctl.proto"

  copy_output_directory() {
    local source_dir="$1"
    local destination_dir="$2"

    if [ ! -d "${source_dir}" ]; then
      return 0
    fi

    local source_real
    local destination_real

    source_real="$(python3 - "${source_dir}" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).resolve(strict=False))
PY
)"
    destination_real="$(python3 - "${destination_dir}" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).resolve(strict=False))
PY
)"
    if [ "${source_real}" = "${destination_real}" ] || [[ "${destination_real}" == "${source_real}/"* ]] || [[ "${source_real}" == "${destination_real}/"* ]]; then
      echo "Skipping output copy to avoid recursive copy: ${source_real} -> ${destination_real}"
      return 0
    fi

    mkdir -p "${destination_dir}"
    cp -R "${source_dir}/." "${destination_dir}/"
  }

  BUILD_OUTPUT=0
  if [ ! -f "${OUTPUT_ENTRY}" ] || [ ! -f "${OUTPUT_PROTO}" ]; then
    BUILD_OUTPUT=1
  fi

  bunx turbo prune --scope=@proompteng/jangar --scope=@proompteng/cx-tools --docker --out-dir="${PRUNE_DIR}"
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
    (cd "${BUILD_DIR}" && bun run --filter @proompteng/otel build)
    (cd "${BUILD_DIR}" && bun run --filter @proompteng/temporal-bun-sdk build)
    (cd "${BUILD_DIR}/services/jangar" && bun run build)
    mkdir -p "${PRUNE_DIR}/full/services/jangar"
    copy_output_directory "${BUILD_DIR}/services/jangar/.output" "${PRUNE_DIR}/full/services/jangar/.output"
  elif [ -f "${OUTPUT_ENTRY}" ] && [ -f "${OUTPUT_PROTO}" ]; then
    mkdir -p "${PRUNE_DIR}/full/services/jangar"
    copy_output_directory "${OUTPUT_SOURCE}" "${PRUNE_DIR}/full/services/jangar/.output"
  elif [ -d "${OUTPUT_SOURCE}" ]; then
    echo "Skipping prebuilt .output: missing ${OUTPUT_ENTRY} or ${OUTPUT_PROTO}"
  fi

  CODEX_AUTH_PATH="${CODEX_AUTH_PATH:-${HOME}/.codex/auth.json}"
  if [ ! -f "${CODEX_AUTH_PATH}" ]; then
    CODEX_AUTH_PATH="${PRUNE_DIR}/codex-auth.json"
    printf '{}' > "${CODEX_AUTH_PATH}"
  fi

  AGENTS_VERSION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
  AGENTS_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"

  DOCKER_BUILDKIT=1 docker build \
    -f "${REPO_ROOT}/services/agents/Dockerfile" \
    --target control-plane \
    -t "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
    --build-arg "AGENTS_VERSION=${AGENTS_VERSION}" \
    --build-arg "AGENTS_COMMIT=${AGENTS_COMMIT}" \
    --secret "id=codexauth,src=${CODEX_AUTH_PATH}" \
    "${PRUNE_DIR}"
fi

echo "Loading image into kind cluster"
kind load docker-image "${IMAGE_REPOSITORY}:${IMAGE_TAG}" --name "${CLUSTER_NAME}"

if "${HELM[@]}" -n "${NAMESPACE}" status "${POSTGRES_RELEASE}" >/dev/null 2>&1; then
  echo "Removing legacy Helm-managed Postgres release ${POSTGRES_RELEASE}"
  "${HELM[@]}" -n "${NAMESPACE}" uninstall "${POSTGRES_RELEASE}"
fi

"${KUBECTL[@]}" -n "${NAMESPACE}" delete statefulset "${POSTGRES_RELEASE}" --ignore-not-found

"${KUBECTL[@]}" -n "${NAMESPACE}" create secret generic "${POSTGRES_RELEASE}-auth" \
  --from-literal=username="${POSTGRES_USER}" \
  --from-literal=password="${POSTGRES_PASSWORD}" \
  --from-literal=database="${POSTGRES_DB}" \
  --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -

cat <<YAML | "${KUBECTL[@]}" apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${POSTGRES_RELEASE}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${POSTGRES_RELEASE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${POSTGRES_RELEASE}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${POSTGRES_RELEASE}
    spec:
      containers:
        - name: postgres
          image: ${POSTGRES_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: ${POSTGRES_RELEASE}-auth
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ${POSTGRES_RELEASE}-auth
                  key: password
            - name: POSTGRES_DB
              valueFrom:
                secretKeyRef:
                  name: ${POSTGRES_RELEASE}-auth
                  key: database
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          readinessProbe:
            exec:
              command:
                - /bin/sh
                - -ec
                - pg_isready -U "\${POSTGRES_USER}" -d "\${POSTGRES_DB}"
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: ${POSTGRES_RELEASE}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${POSTGRES_RELEASE}
spec:
  selector:
    app.kubernetes.io/name: ${POSTGRES_RELEASE}
  ports:
    - name: postgres
      port: 5432
      targetPort: postgres
YAML

"${KUBECTL[@]}" -n "${NAMESPACE}" rollout status deployment "${POSTGRES_RELEASE}" --timeout=180s
"${KUBECTL[@]}" -n "${NAMESPACE}" wait \
  --for=condition=Ready pod \
  -l "app.kubernetes.io/name=${POSTGRES_RELEASE}" \
  --timeout=180s

POSTGRES_POD="$("${KUBECTL[@]}" -n "${NAMESPACE}" get pod \
  -l "app.kubernetes.io/name=${POSTGRES_RELEASE}" \
  -o jsonpath='{.items[0].metadata.name}')"

"${KUBECTL[@]}" -n "${NAMESPACE}" exec "${POSTGRES_POD}" -- \
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;'

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_RELEASE}.${NAMESPACE}.svc.cluster.local:5432/${POSTGRES_DB}?sslmode=disable"

"${KUBECTL[@]}" -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
  --from-literal="${SECRET_KEY}=${DATABASE_URL}" \
  --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -

"${HELM[@]}" upgrade --install agents "${CHART_PATH}" \
  --namespace "${NAMESPACE}" \
  --values "${VALUES_FILE}" \
  --set image.repository="${IMAGE_REPOSITORY}" \
  --set image.tag="${IMAGE_TAG}"

"${KUBECTL[@]}" -n "${NAMESPACE}" rollout restart deployment/agents
"${KUBECTL[@]}" -n "${NAMESPACE}" rollout status deployment/agents --timeout=180s

"${KUBECTL[@]}" -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/agentprovider-smoke.yaml"
"${KUBECTL[@]}" -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/agent-smoke.yaml"
"${KUBECTL[@]}" -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/implementationspec-smoke.yaml"
"${KUBECTL[@]}" -n "${NAMESPACE}" apply -f "${CHART_PATH}/examples/agentrun-workflow-smoke.yaml"

"${KUBECTL[@]}" -n "${NAMESPACE}" wait --for=condition=Succeeded agentrun/agents-workflow-smoke --timeout=300s

"${KUBECTL[@]}" -n "${NAMESPACE}" get agentruns agents-workflow-smoke -o wide

cat <<'OUT'

Agents chart kind run complete.

Next steps:
- Port-forward the control plane: kubectl --context kind-agents -n agents port-forward svc/agents 8080:80
- Inspect AgentRun details: kubectl --context kind-agents -n agents describe agentrun agents-workflow-smoke
- List Jobs created by the controller: kubectl --context kind-agents -n agents get jobs
OUT
