#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"

go generate "${ROOT_DIR}/services/jangar/api/agents"

git -C "${ROOT_DIR}" diff --exit-code -- "${CHART_DIR}/crds" \
  "${ROOT_DIR}/services/jangar/api/agents/v1alpha1/zz_generated.deepcopy.go"

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
render_and_check "${CHART_DIR}/values-local.yaml"
render_and_check "${CHART_DIR}/values-prod.yaml"

python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_agents.yaml" agents.proompteng.ai v1alpha1 Agent
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_agentruns.yaml" agents.proompteng.ai v1alpha1 AgentRun
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_agentproviders.yaml" agents.proompteng.ai v1alpha1 AgentProvider
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_implementationspecs.yaml" agents.proompteng.ai v1alpha1 ImplementationSpec
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_implementationsources.yaml" agents.proompteng.ai v1alpha1 ImplementationSource
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_memories.yaml" agents.proompteng.ai v1alpha1 Memory
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/orchestration.proompteng.ai_orchestrations.yaml" orchestration.proompteng.ai v1alpha1 Orchestration
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/orchestration.proompteng.ai_orchestrationruns.yaml" orchestration.proompteng.ai v1alpha1 OrchestrationRun
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/approvals.proompteng.ai_approvalpolicies.yaml" approvals.proompteng.ai v1alpha1 ApprovalPolicy
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/budgets.proompteng.ai_budgets.yaml" budgets.proompteng.ai v1alpha1 Budget
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/security.proompteng.ai_secretbindings.yaml" security.proompteng.ai v1alpha1 SecretBinding
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/signals.proompteng.ai_signals.yaml" signals.proompteng.ai v1alpha1 Signal
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/signals.proompteng.ai_signaldeliveries.yaml" signals.proompteng.ai v1alpha1 SignalDelivery
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/tools.proompteng.ai_tools.yaml" tools.proompteng.ai v1alpha1 Tool
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/tools.proompteng.ai_toolruns.yaml" tools.proompteng.ai v1alpha1 ToolRun
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/schedules.proompteng.ai_schedules.yaml" schedules.proompteng.ai v1alpha1 Schedule
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/artifacts.proompteng.ai_artifacts.yaml" artifacts.proompteng.ai v1alpha1 Artifact
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/workspaces.proompteng.ai_workspaces.yaml" workspaces.proompteng.ai v1alpha1 Workspace

python3 - <<'PY'
import sys
from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[2]
crd_dir = root / "charts" / "agents" / "crds"
examples_dir = root / "charts" / "agents" / "examples"

crd_versions = {}
for path in crd_dir.glob("*.yaml"):
    doc = yaml.safe_load(path.read_text())
    if not doc:
        continue
    group = doc.get("spec", {}).get("group")
    kind = doc.get("spec", {}).get("names", {}).get("kind")
    if not group or not kind:
        continue
    versions = {v.get("name") for v in doc.get("spec", {}).get("versions", []) if v.get("name")}
    crd_versions[(group, kind)] = versions

errors = []
for path in examples_dir.glob("*.yaml"):
    for doc in yaml.safe_load_all(path.read_text()):
        if not isinstance(doc, dict):
            continue
        api_version = doc.get("apiVersion")
        kind = doc.get("kind")
        if not api_version or not kind or "/" not in api_version:
            continue
        group, version = api_version.split("/", 1)
        key = (group, kind)
        if key not in crd_versions:
            errors.append(f"{path}: {kind} uses {api_version} but no CRD found for {group}/{kind}")
            continue
        if version not in crd_versions[key]:
            errors.append(
                f"{path}: {kind} uses {api_version} but CRD only has versions {sorted(crd_versions[key])}"
            )

if errors:
    print("Example manifests reference missing CRDs or versions:", file=sys.stderr)
    for error in errors:
        print(f" - {error}", file=sys.stderr)
    sys.exit(1)
PY

schema_dir="${ROOT_DIR}/schemas/custom"
if ! command -v kubeconform >/dev/null 2>&1; then
  echo "kubeconform is required but not installed" >&2
  exit 1
fi

kubeconform --strict --summary --ignore-missing-schemas \
  --schema-location "${schema_dir}/{{.ResourceKind}}{{.KindSuffix}}.json" \
  --schema-location "${schema_dir}/{{.Group}}_{{.ResourceAPIVersion}}_{{.ResourceKind}}.json" \
  --schema-location "${schema_dir}/{{.Group}}/{{.ResourceAPIVersion}}/{{.ResourceKind}}.json" \
  --schema-location "${schema_dir}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  --schema-location "${schema_dir}/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json" \
  --schema-location "${schema_dir}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  --schema-location default \
  "${CHART_DIR}/examples"/*.yaml

kubeconform --strict --summary --ignore-missing-schemas \
  --schema-location "${schema_dir}/{{.ResourceKind}}{{.KindSuffix}}.json" \
  --schema-location "${schema_dir}/{{.Group}}_{{.ResourceAPIVersion}}_{{.ResourceKind}}.json" \
  --schema-location "${schema_dir}/{{.Group}}/{{.ResourceAPIVersion}}/{{.ResourceKind}}.json" \
  --schema-location "${schema_dir}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  --schema-location "${schema_dir}/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json" \
  --schema-location "${schema_dir}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
  --schema-location default \
  "${ROOT_DIR}/argocd/applications/agents/application.yaml"

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
