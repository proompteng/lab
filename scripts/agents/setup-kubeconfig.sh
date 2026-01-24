#!/usr/bin/env bash
set -euo pipefail

KUBECONFIG_PATH="${KUBECONFIG:-$HOME/.kube/config}"
CONTEXT_NAME="${KUBE_CONTEXT_NAME:-in-cluster}"
CLUSTER_NAME="${KUBE_CLUSTER_NAME:-in-cluster}"
NAMESPACE="${KUBE_NAMESPACE:-default}"

TOKEN_FILE="${KUBE_TOKEN_FILE:-/var/run/secrets/kubernetes.io/serviceaccount/token}"
CA_FILE="${KUBE_CA_FILE:-/var/run/secrets/kubernetes.io/serviceaccount/ca.crt}"

if [[ -z "${KUBERNETES_SERVICE_HOST:-}" || -z "${KUBERNETES_SERVICE_PORT:-}" ]]; then
  echo "KUBERNETES_SERVICE_HOST/PORT not set; not running in cluster?" >&2
  exit 1
fi

if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "Service account token not found at ${TOKEN_FILE}" >&2
  exit 1
fi

if [[ ! -f "${CA_FILE}" ]]; then
  echo "Service account CA not found at ${CA_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${KUBECONFIG_PATH}")"

SERVER="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"
TOKEN="$(cat "${TOKEN_FILE}")"

kubectl config set-cluster "${CLUSTER_NAME}" \
  --server="${SERVER}" \
  --certificate-authority="${CA_FILE}" \
  --embed-certs=true \
  --kubeconfig="${KUBECONFIG_PATH}"

kubectl config set-credentials "${CLUSTER_NAME}-sa" \
  --token="${TOKEN}" \
  --kubeconfig="${KUBECONFIG_PATH}"

kubectl config set-context "${CONTEXT_NAME}" \
  --cluster="${CLUSTER_NAME}" \
  --user="${CLUSTER_NAME}-sa" \
  --namespace="${NAMESPACE}" \
  --kubeconfig="${KUBECONFIG_PATH}"

kubectl config use-context "${CONTEXT_NAME}" --kubeconfig="${KUBECONFIG_PATH}"

echo "Kubeconfig written to ${KUBECONFIG_PATH} (context ${CONTEXT_NAME})"
