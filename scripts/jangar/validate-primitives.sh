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
CNPG_FLAGS_RAW="${CNPG_FLAGS:-}"
CNPG_FLAGS=()
if [ -n "${CNPG_FLAGS_RAW}" ]; then
  read -r -a CNPG_FLAGS <<< "${CNPG_FLAGS_RAW}"
fi
if [ "${#CNPG_FLAGS[@]}" -eq 0 ]; then
  CNPG_FLAGS=(--tty=false --stdin=false)
fi

require_kubectl() {
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl not found in PATH" >&2
    exit 1
  fi
}

require_cnpg() {
  if ! kubectl cnpg version >/dev/null 2>&1; then
    echo "kubectl cnpg plugin not available (install kubectl-cnpg)" >&2
    exit 1
  fi
}

require_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    echo "python"
    return 0
  fi
  echo "python not found in PATH (required for orchestration run validation)" >&2
  exit 1
}

check_package_pin() {
  local kind="$1"
  local name="$2"
  local package
  package=$(kubectl get "${kind}.pkg.crossplane.io" "${name}" -o jsonpath='{.spec.package}' 2>/dev/null || true)
  if [ -z "${package}" ]; then
    echo "${kind} ${name} package is missing" >&2
    exit 1
  fi
  if [[ "${package}" == *":latest" || "${package}" == *"@latest" ]]; then
    echo "${kind} ${name} is pinned to latest (${package}); use an immutable tag" >&2
    exit 1
  fi
  echo "${kind} ${name} package pinned: ${package}"
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
  kubectl cnpg psql -n "${JANGAR_NAMESPACE}" "${JANGAR_DB_CLUSTER}" "${CNPG_FLAGS[@]}" -- -d "${JANGAR_DB_NAME}" -c \
    "select to_regclass('public.agent_runs'), to_regclass('public.orchestration_runs'), to_regclass('public.memory_resources'), to_regclass('public.audit_events');"
}

fetch_count() {
  local namespace="$1"
  local cluster="$2"
  local database="$3"
  local query="$4"
  kubectl cnpg psql -n "${namespace}" "${cluster}" "${CNPG_FLAGS[@]}" -- -d "${database}" -tA -c "${query}" \
    | tr -d '[:space:]'
}

assert_nonzero_count() {
  local label="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${label} count is not numeric: ${value}" >&2
    exit 1
  fi
  if [ "${value}" -le 0 ]; then
    echo "${label} count is zero; expected non-zero rows" >&2
    exit 1
  fi
  echo "${label}: ${value}"
}

check_memory_tables() {
  local events
  local kv
  local embeddings
  events="$(fetch_count "${FACTEUR_NAMESPACE}" "${FACTEUR_DB_CLUSTER}" "${FACTEUR_DB_NAME}" \
    "select count(*) from ${MEMORY_SCHEMA}.memory_events;")"
  kv="$(fetch_count "${FACTEUR_NAMESPACE}" "${FACTEUR_DB_CLUSTER}" "${FACTEUR_DB_NAME}" \
    "select count(*) from ${MEMORY_SCHEMA}.memory_kv;")"
  embeddings="$(fetch_count "${FACTEUR_NAMESPACE}" "${FACTEUR_DB_CLUSTER}" "${FACTEUR_DB_NAME}" \
    "select count(*) from ${MEMORY_SCHEMA}.memory_embeddings;")"

  assert_nonzero_count "memory_events" "${events}"
  assert_nonzero_count "memory_kv" "${kv}"
  assert_nonzero_count "memory_embeddings" "${embeddings}"
}

check_crossplane_resources() {
  echo "== Crossplane configurations/functions =="
  check_crossplane_package configuration configuration-agents
  check_crossplane_package function function-map-to-list
  check_package_pin configuration configuration-agents
  check_package_pin function function-map-to-list
}

check_orchestration_runs() {
  echo "== OrchestrationRuns with stepStatuses =="
  kubectl get orchestrationruns.orchestration.proompteng.ai -n "${JANGAR_NAMESPACE}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.stepStatuses}{"\n"}{end}'
  local python_bin
  python_bin="$(require_python)"
  kubectl get orchestrationruns.orchestration.proompteng.ai -n "${JANGAR_NAMESPACE}" -o json | "${python_bin}" -c '
import json
import sys

data = json.load(sys.stdin)
items = data.get("items", [])
def has_steps(item):
  status = item.get("status") or {}
  steps = status.get("stepStatuses") or []
  return bool(steps)

good = [item for item in items if (item.get("status") or {}).get("phase") == "Succeeded" and has_steps(item)]
if not good:
  print("no succeeded orchestration runs with populated stepStatuses found", file=sys.stderr)
  sys.exit(1)

name = good[0].get("metadata", {}).get("name", "<unknown>")
print(f"Found succeeded orchestration run with stepStatuses: {name}")
'
}

main() {
  require_kubectl
  require_cnpg
  check_crossplane_resources
  echo "== Jangar DB tables =="
  check_jangar_tables
  echo "== Memory provider tables =="
  check_memory_tables
  check_orchestration_runs
  echo "Validation complete."
}

main "$@"
