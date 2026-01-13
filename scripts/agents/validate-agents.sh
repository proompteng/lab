#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"

helm lint "${CHART_DIR}"

render_and_check() {
  local values_file="$1"
  local output
  output="$(mktemp)"
  helm template "${CHART_DIR}" --values "${values_file}" >"${output}"

  if rg -n "^kind: (Ingress|StatefulSet|CronJob|PersistentVolumeClaim)" "${output}"; then
    echo "Disallowed resources found in rendered chart (${values_file})" >&2
    exit 1
  fi
}

render_and_check "${CHART_DIR}/values-dev.yaml"
render_and_check "${CHART_DIR}/values-prod.yaml"

python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agent.yaml" agents.proompteng.ai v1alpha1 Agent
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agentrun.yaml" agents.proompteng.ai v1alpha1 AgentRun
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agentprovider.yaml" agents.proompteng.ai v1alpha1 AgentProvider
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/implementationspec.yaml" agents.proompteng.ai v1alpha1 ImplementationSpec
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/implementationsource.yaml" agents.proompteng.ai v1alpha1 ImplementationSource
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/memory.yaml" agents.proompteng.ai v1alpha1 Memory

schema_dir="${ROOT_DIR}/schemas/custom"
if ! command -v kubeconform >/dev/null 2>&1; then
  echo "kubeconform is required but not installed" >&2
  exit 1
fi

kubeconform --strict --summary \
  --schema-location default \
  --schema-location "${schema_dir}/{{.Group}}_{{.ResourceAPIVersion}}_{{.ResourceKind}}.json" \
  "${CHART_DIR}/examples"/*.yaml

CRD_DIR="${CHART_DIR}/crds" python3 - <<'PY'
import json
import os
import yaml
from pathlib import Path

crd_dir = Path(os.environ['CRD_DIR'])
max_bytes = 256 * 1024

for path in crd_dir.glob('*.yaml'):
    data = yaml.safe_load(path.read_text())
    size = len(json.dumps(data))
    if size > max_bytes:
        raise SystemExit(f"{path} exceeds size limit: {size} bytes")
    print(f"{path.name}: {size} bytes")
PY
