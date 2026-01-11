#!/usr/bin/env bash
set -euo pipefail

JANGAR_NAMESPACE="${JANGAR_NAMESPACE:-jangar}"
ARGO_NAMESPACE="${ARGO_NAMESPACE:-argo-workflows}"
FACTEUR_NAMESPACE="${FACTEUR_NAMESPACE:-facteur}"
JANGAR_DB_CLUSTER="${JANGAR_DB_CLUSTER:-jangar-db}"
JANGAR_DB_NAME="${JANGAR_DB_NAME:-jangar}"
FACTEUR_DB_CLUSTER="${FACTEUR_DB_CLUSTER:-facteur-vector-cluster}"
FACTEUR_DB_NAME="${FACTEUR_DB_NAME:-facteur_kb}"
MEMORY_SCHEMA="${MEMORY_SCHEMA:-jangar_primitives}"

require_kubectl() {
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl not found in PATH" >&2
    exit 1
  fi
}

check_crossplane_package() {
  local kind="$1"
  local name="$2"
  local installed
  local healthy

  installed=$(kubectl get "${kind}.pkg.crossplane.io" "${name}" -o jsonpath='{.status.conditions[?(@.type=="Installed")].status}' 2>/dev/null || true)
  healthy=$(kubectl get "${kind}.pkg.crossplane.io" "${name}" -o jsonpath='{.status.conditions[?(@.type=="Healthy")].status}' 2>/dev/null || true)

  if [[ "${installed}" != "True" || "${healthy}" != "True" ]]; then
    echo "${kind} ${name} not ready (Installed=${installed:-missing}, Healthy=${healthy:-missing})" >&2
    exit 1
  fi
  echo "${kind} ${name}: Installed=${installed} Healthy=${healthy}"
}

check_jangar_tables() {
  kubectl cnpg psql -n "${JANGAR_NAMESPACE}" "${JANGAR_DB_CLUSTER}" -- -d "${JANGAR_DB_NAME}" -c \
    "select to_regclass('public.agent_runs'), to_regclass('public.orchestration_runs'), to_regclass('public.memory_resources'), to_regclass('public.audit_events');"
}

check_memory_tables() {
  kubectl cnpg psql -n "${FACTEUR_NAMESPACE}" "${FACTEUR_DB_CLUSTER}" -- -d "${FACTEUR_DB_NAME}" -c \
    "select count(*) as memory_events from ${MEMORY_SCHEMA}.memory_events;"
  kubectl cnpg psql -n "${FACTEUR_NAMESPACE}" "${FACTEUR_DB_CLUSTER}" -- -d "${FACTEUR_DB_NAME}" -c \
    "select count(*) as memory_kv from ${MEMORY_SCHEMA}.memory_kv;"
  kubectl cnpg psql -n "${FACTEUR_NAMESPACE}" "${FACTEUR_DB_CLUSTER}" -- -d "${FACTEUR_DB_NAME}" -c \
    "select count(*) as memory_embeddings from ${MEMORY_SCHEMA}.memory_embeddings;"
}

check_crossplane_resources() {
  echo "== Crossplane configurations/functions =="
  check_crossplane_package configuration configuration-agents
  check_crossplane_package function function-map-to-list
}

check_orchestration_runs() {
  echo "== OrchestrationRuns with stepStatuses =="
  kubectl get orchestrationruns.orchestration.proompteng.ai -n "${JANGAR_NAMESPACE}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.stepStatuses}{"\n"}{end}'
  echo "Inspect stepStatuses for each run above to confirm population."
}

main() {
  require_kubectl
  check_crossplane_resources
  echo "== Jangar DB tables =="
  check_jangar_tables
  echo "== Memory provider tables =="
  check_memory_tables
  check_orchestration_runs
  echo "Validation complete."
}

main "$@"
