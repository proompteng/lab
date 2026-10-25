#!/usr/bin/env bash
set -euo pipefail

AGENTS_NAMESPACE="${AGENTS_NAMESPACE:-agents}"
AGENTS_DB_NAMESPACE="${AGENTS_DB_NAMESPACE:-${AGENTS_NAMESPACE}}"
AGENTS_DB_CLUSTER="${AGENTS_DB_CLUSTER:-agents-db-next}"
AGENTS_DB_NAME="${AGENTS_DB_NAME:-agents}"
MEMORY_NAMESPACE="${MEMORY_NAMESPACE:-${AGENTS_NAMESPACE}}"
MEMORY_NAME="${MEMORY_NAME:-agents-primitives}"
MEMORY_DB_NAMESPACE="${MEMORY_DB_NAMESPACE:-${AGENTS_DB_NAMESPACE}}"
MEMORY_DB_CLUSTER="${MEMORY_DB_CLUSTER:-${AGENTS_DB_CLUSTER}}"
MEMORY_DB_NAME="${MEMORY_DB_NAME:-${AGENTS_DB_NAME}}"
MEMORY_SCHEMA="${MEMORY_SCHEMA:-public}"
MEMORY_DATASET="${MEMORY_DATASET:-${MEMORY_NAME}}"
ORCHESTRATION_NAMESPACE="${ORCHESTRATION_NAMESPACE:-${AGENTS_NAMESPACE}}"
AGENTS_BASE_URL="${AGENTS_BASE_URL:-}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-10}"
REQUIRE_MEMORY_DATA="${REQUIRE_MEMORY_DATA:-0}"
REQUIRE_SUCCEEDED_RUN="${REQUIRE_SUCCEEDED_RUN:-0}"

PYTHON_BIN=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/jangar/validate-primitives.sh [options]

Read-only validation of the Agents-owned primitives used by Jangar.

Options:
  --require-memory-data     fail unless the selected Memory dataset has rows in
                            memory_events, memory_kv, and memory_embeddings
  --require-succeeded-run   fail unless a Succeeded OrchestrationRun has stepStatuses
  --help                    show this help

The script never creates, patches, deletes, or submits a resource. Set
AGENTS_BASE_URL to additionally probe read-only Agents HTTP routes. Database and
Memory targets can be overridden with the AGENTS_*, MEMORY_*, and
ORCHESTRATION_NAMESPACE environment variables.
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --require-memory-data)
        REQUIRE_MEMORY_DATA=1
        ;;
      --require-succeeded-run)
        REQUIRE_SUCCEEDED_RUN=1
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown option: $1"
        ;;
    esac
    shift
  done
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 || die "${command_name} not found in PATH"
}

validate_kubernetes_name() {
  local label="$1"
  local value="$2"
  [[ "${value}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || \
    die "${label} must be a DNS label (got '${value}')"
}

validate_database_name() {
  local label="$1"
  local value="$2"
  [[ "${value}" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*$ ]] || \
    die "${label} must be a simple PostgreSQL database name (got '${value}')"
}

validate_sql_identifier() {
  local label="$1"
  local value="$2"
  [[ "${value}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || \
    die "${label} must be a simple PostgreSQL identifier (got '${value}')"
}

normalize_boolean() {
  local label="$1"
  local value="$2"
  local normalized
  normalized="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    0|1|true|false|yes|no|on|off)
      printf '%s' "${normalized}"
      ;;
    *)
      die "${label} must be a boolean (got '${value}')"
      ;;
  esac
}

validate_positive_integer() {
  local label="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || die "${label} must be a positive integer (got '${value}')"
}

validate_configuration() {
  validate_kubernetes_name "AGENTS_NAMESPACE" "${AGENTS_NAMESPACE}"
  validate_kubernetes_name "AGENTS_DB_NAMESPACE" "${AGENTS_DB_NAMESPACE}"
  validate_kubernetes_name "AGENTS_DB_CLUSTER" "${AGENTS_DB_CLUSTER}"
  validate_database_name "AGENTS_DB_NAME" "${AGENTS_DB_NAME}"
  validate_kubernetes_name "MEMORY_NAMESPACE" "${MEMORY_NAMESPACE}"
  validate_kubernetes_name "MEMORY_NAME" "${MEMORY_NAME}"
  validate_kubernetes_name "MEMORY_DB_NAMESPACE" "${MEMORY_DB_NAMESPACE}"
  validate_kubernetes_name "MEMORY_DB_CLUSTER" "${MEMORY_DB_CLUSTER}"
  validate_database_name "MEMORY_DB_NAME" "${MEMORY_DB_NAME}"
  validate_sql_identifier "MEMORY_SCHEMA" "${MEMORY_SCHEMA}"
  [[ -n "${MEMORY_DATASET}" && "${MEMORY_DATASET}" != *$'\n'* && "${MEMORY_DATASET}" != *$'\r'* ]] || \
    die "MEMORY_DATASET must be non-empty and must not contain newlines"
  validate_kubernetes_name "ORCHESTRATION_NAMESPACE" "${ORCHESTRATION_NAMESPACE}"
  REQUIRE_MEMORY_DATA="$(normalize_boolean "REQUIRE_MEMORY_DATA" "${REQUIRE_MEMORY_DATA}")"
  REQUIRE_SUCCEEDED_RUN="$(normalize_boolean "REQUIRE_SUCCEEDED_RUN" "${REQUIRE_SUCCEEDED_RUN}")"
  validate_positive_integer "API_TIMEOUT_SECONDS" "${API_TIMEOUT_SECONDS}"

  if [[ -n "${AGENTS_BASE_URL}" ]]; then
    [[ "${AGENTS_BASE_URL}" != *[[:space:]]* ]] || die "AGENTS_BASE_URL must not contain whitespace"
    case "${AGENTS_BASE_URL}" in
      http://*|https://*) ;;
      *) die "AGENTS_BASE_URL must start with http:// or https://" ;;
    esac
  fi
}

require_kubectl() {
  require_command kubectl
}

require_cnpg() {
  if ! kubectl cnpg version --namespace "${AGENTS_DB_NAMESPACE}" >/dev/null 2>&1; then
    die "kubectl cnpg plugin not available (install kubectl-cnpg)"
  fi
}

require_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    command -v python
    return 0
  fi
  die "python3 or python not found in PATH"
}

require_curl() {
  require_command curl
}

cnpg_psql() {
  local namespace="$1"
  local cluster="$2"
  local database="$3"
  shift 3
  kubectl cnpg psql --namespace "${namespace}" "${cluster}" \
    --tty=false --stdin=false -- \
    --dbname "${database}" "$@"
}

check_memory_resource() {
  echo "== Memory resource =="
  local memory_json
  memory_json="$(kubectl --namespace "${MEMORY_NAMESPACE}" \
    get memories.agents.proompteng.ai "${MEMORY_NAME}" -o json)"
  printf '%s\n' "${memory_json}" | "${PYTHON_BIN}" -c '
import json
import sys

expected_namespace, expected_name = sys.argv[1:3]
resource = json.load(sys.stdin)
metadata = resource.get("metadata") or {}
spec = resource.get("spec") or {}
connection = spec.get("connection") or {}
secret_ref = connection.get("secretRef") or {}
errors = []
metadata_name = metadata.get("name")
metadata_namespace = metadata.get("namespace")
spec_type = spec.get("type")

if metadata_name != expected_name:
    errors.append(f"metadata.name is {metadata_name!r}, expected {expected_name!r}")
if metadata_namespace != expected_namespace:
    errors.append(f"metadata.namespace is {metadata_namespace!r}, expected {expected_namespace!r}")
if spec_type != "postgres":
    errors.append(f"spec.type is {spec_type!r}, expected \"postgres\"")
if not isinstance(secret_ref.get("name"), str) or not secret_ref["name"].strip():
    errors.append("spec.connection.secretRef.name is missing")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    sys.exit(1)

status = resource.get("status") or {}
ready = "Unknown"
for condition in status.get("conditions", []) or []:
    if isinstance(condition, dict) and condition.get("type") == "Ready":
        ready = str(condition.get("status", "Unknown"))
        break

secret_key = secret_ref.get("key") or "uri/password fields"
secret_name = secret_ref["name"]
print(f"Memory {expected_namespace}/{expected_name}: type=postgres, secretRef={secret_name}, key={secret_key}, Ready={ready}")
' "${MEMORY_NAMESPACE}" "${MEMORY_NAME}"
}

check_required_extensions() {
  local label="$1"
  local namespace="$2"
  local cluster="$3"
  local database="$4"
  local rows
  local extension_query
  extension_query="SELECT extname FROM pg_catalog.pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname;"
  rows="$(cnpg_psql "${namespace}" "${cluster}" "${database}" \
    --tuples-only --no-align --quiet \
    --command "${extension_query}")"
  local missing
  missing="$(printf '%s\n' "${rows}" | "${PYTHON_BIN}" -c '
import sys

expected = {"vector", "pgcrypto"}
actual = {line.strip() for line in sys.stdin if line.strip()}
print("\n".join(sorted(expected - actual)))
')"
  if [[ -n "${missing}" ]]; then
    die "${label} is missing PostgreSQL extensions: ${missing//$'\n'/, }"
  fi
  echo "${label}: vector, pgcrypto"
}

check_agents_schema() {
  echo "== Agents database schema =="
  local rows
  rows="$(cnpg_psql "${AGENTS_DB_NAMESPACE}" "${AGENTS_DB_CLUSTER}" "${AGENTS_DB_NAME}" \
    --tuples-only --no-align --quiet \
    --command "
      SELECT n.nspname || '.' || c.relname
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE (n.nspname, c.relname) IN (
        ('public', 'agent_runs'),
        ('public', 'agent_run_idempotency_keys'),
        ('public', 'memory_resources'),
        ('public', 'orchestration_runs'),
        ('public', 'audit_events'),
        ('memories', 'entries'),
        ('agents_control_plane', 'resources_current')
      )
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY 1;
    ")"
  local missing
  missing="$(printf '%s\n' "${rows}" | "${PYTHON_BIN}" -c '
import sys

expected = {
    "public.agent_runs",
    "public.agent_run_idempotency_keys",
    "public.memory_resources",
    "public.orchestration_runs",
    "public.audit_events",
    "memories.entries",
    "agents_control_plane.resources_current",
}
actual = {line.strip() for line in sys.stdin if line.strip()}
print("\n".join(sorted(expected - actual)))
')"
  if [[ -n "${missing}" ]]; then
    die "Agents database is missing relations: ${missing//$'\n'/, }"
  fi
  echo "Agents relations: agent_runs, agent_run_idempotency_keys, memory_resources, orchestration_runs, audit_events, memories.entries, agents_control_plane.resources_current"
  check_required_extensions "Agents database" "${AGENTS_DB_NAMESPACE}" "${AGENTS_DB_CLUSTER}" "${AGENTS_DB_NAME}"
}

check_memory_provider_schema() {
  echo "== Memory provider schema =="
  local rows
  rows="$(cnpg_psql "${MEMORY_DB_NAMESPACE}" "${MEMORY_DB_CLUSTER}" "${MEMORY_DB_NAME}" \
    --tuples-only --no-align --quiet \
    --command "
      SELECT n.nspname || '.' || c.relname
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = '${MEMORY_SCHEMA}'
        AND c.relname IN ('memory_events', 'memory_kv', 'memory_embeddings')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY 1;
    ")"
  local missing
  missing="$(printf '%s\n' "${rows}" | "${PYTHON_BIN}" -c '
import sys

schema = sys.argv[1]
expected = {f"{schema}.{table}" for table in ("memory_events", "memory_kv", "memory_embeddings")}
actual = {line.strip() for line in sys.stdin if line.strip()}
print("\n".join(sorted(expected - actual)))
' "${MEMORY_SCHEMA}")"
  if [[ -n "${missing}" ]]; then
    die "Memory provider database is missing relations: ${missing//$'\n'/, }"
  fi
  check_required_extensions "Memory provider database" \
    "${MEMORY_DB_NAMESPACE}" "${MEMORY_DB_CLUSTER}" "${MEMORY_DB_NAME}"
  echo "Memory provider relations: ${MEMORY_SCHEMA}.memory_events, ${MEMORY_SCHEMA}.memory_kv, ${MEMORY_SCHEMA}.memory_embeddings"
}

fetch_memory_count() {
  local table="$1"
  local count
  count="$(cnpg_psql "${MEMORY_DB_NAMESPACE}" "${MEMORY_DB_CLUSTER}" "${MEMORY_DB_NAME}" \
    --tuples-only --no-align --quiet \
    "--set=memory_dataset=${MEMORY_DATASET}" \
    --command "SELECT count(*)::bigint FROM \"${MEMORY_SCHEMA}\".\"${table}\" WHERE dataset = :'memory_dataset';" \
    | tr -d '[:space:]')"
  [[ "${count}" =~ ^[0-9]+$ ]] || die "${table} count is not numeric: ${count}"
  printf '%s' "${count}"
}

check_memory_counts() {
  echo "== Memory provider rows =="
  local events
  local kv
  local embeddings
  events="$(fetch_memory_count memory_events)"
  kv="$(fetch_memory_count memory_kv)"
  embeddings="$(fetch_memory_count memory_embeddings)"
  echo "${MEMORY_SCHEMA}.memory_events dataset=${MEMORY_DATASET}: ${events}"
  echo "${MEMORY_SCHEMA}.memory_kv dataset=${MEMORY_DATASET}: ${kv}"
  echo "${MEMORY_SCHEMA}.memory_embeddings dataset=${MEMORY_DATASET}: ${embeddings}"

  if [[ "${REQUIRE_MEMORY_DATA}" == "1" || "${REQUIRE_MEMORY_DATA}" == "true" || "${REQUIRE_MEMORY_DATA}" == "yes" || "${REQUIRE_MEMORY_DATA}" == "on" ]]; then
    [[ "${events}" -gt 0 ]] || die "memory_events has no rows for dataset ${MEMORY_DATASET}"
    [[ "${kv}" -gt 0 ]] || die "memory_kv has no rows for dataset ${MEMORY_DATASET}"
    [[ "${embeddings}" -gt 0 ]] || die "memory_embeddings has no rows for dataset ${MEMORY_DATASET}"
  fi
}

check_orchestration_runs() {
  echo "== OrchestrationRuns =="
  local runs_json
  runs_json="$(kubectl --namespace "${ORCHESTRATION_NAMESPACE}" \
    get orchestrationruns.orchestration.proompteng.ai -o json)"
  printf '%s\n' "${runs_json}" | "${PYTHON_BIN}" -c '
import json
import sys

require_succeeded = sys.argv[1] in {"1", "true", "yes", "on"}
data = json.load(sys.stdin)
items = data.get("items") or []
good = []

for item in items:
    metadata = item.get("metadata") or {}
    status = item.get("status") or {}
    name = metadata.get("name", "<unknown>")
    phase = status.get("phase", "<unset>")
    steps = status.get("stepStatuses")
    step_count = len(steps) if isinstance(steps, list) else 0
    print(f"{name}: phase={phase}, stepStatuses={step_count}")
    if phase == "Succeeded" and step_count > 0:
        good.append(name)

if require_succeeded and not good:
    print("no succeeded orchestration run with populated stepStatuses found", file=sys.stderr)
    sys.exit(1)
if good:
    print(f"Validated succeeded orchestration run: {good[0]}")
' "${REQUIRE_SUCCEEDED_RUN}"
}

check_agents_api() {
  if [[ -z "${AGENTS_BASE_URL}" ]]; then
    echo "== Agents API: skipped (set AGENTS_BASE_URL to probe read-only routes) =="
    return 0
  fi

  require_curl
  echo "== Agents API =="
  local base="${AGENTS_BASE_URL%/}"
  local endpoint
  local endpoints=(
    "/health"
    "/ready"
    "/v1/control-plane/status?namespace=${AGENTS_NAMESPACE}"
    "/v1/agent-runs/resources?namespace=${AGENTS_NAMESPACE}&limit=1"
    "/v1/memories/resources?namespace=${MEMORY_NAMESPACE}&limit=1"
    "/v1/orchestration-runs/resources?namespace=${ORCHESTRATION_NAMESPACE}&limit=1"
  )

  for endpoint in "${endpoints[@]}"; do
    curl --fail --silent --show-error --max-time "${API_TIMEOUT_SECONDS}" \
      --header 'accept: application/json' "${base}${endpoint}" >/dev/null
    echo "GET ${endpoint}: ok"
  done
}

main() {
  parse_args "$@"
  validate_configuration
  require_kubectl
  require_cnpg
  PYTHON_BIN="$(require_python)"

  echo "Agents namespace: ${AGENTS_NAMESPACE}"
  echo "Agents database: ${AGENTS_DB_NAMESPACE}/${AGENTS_DB_CLUSTER}/${AGENTS_DB_NAME}"
  echo "Memory resource: ${MEMORY_NAMESPACE}/${MEMORY_NAME}"
  echo "Memory database: ${MEMORY_DB_NAMESPACE}/${MEMORY_DB_CLUSTER}/${MEMORY_DB_NAME}"

  check_memory_resource
  check_agents_schema
  check_memory_provider_schema
  check_memory_counts
  check_orchestration_runs
  check_agents_api
  echo "Validation complete (read-only)."
}

main "$@"
