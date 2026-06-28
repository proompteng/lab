#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
ARGOCD_AGENTS_DIR="${ROOT_DIR}/argocd/applications/agents"
CI_VALUES_FILE="${ROOT_DIR}/scripts/agents/values-ci.yaml"
# Backward-compatible: older callers used HELM_KUBE_VERSION.
KUBE_VERSION_FOR_HELM="${KUBE_VERSION_FOR_HELM:-${HELM_KUBE_VERSION:-1.35.0}}"
DUMMY_IMAGE_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"
TEST_IMAGE_DIGEST="sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69"

if [[ -d "${ROOT_DIR}/services/jangar/api/agents" ]]; then
  echo "Agents CRD Go sources must live under services/agents/api/agents, not services/jangar/api/agents." >&2
  exit 1
fi

if command -v rg >/dev/null 2>&1; then
  if rg -n "codex-universal|ghcr.io/openai/codex-universal" \
    "${CHART_DIR}/examples" \
    "${ROOT_DIR}/scripts/agents/native-workflow-e2e.sh"; then
    echo "Agents examples must use the chart-managed agents-codex-runner image, not codex-universal." >&2
    exit 1
  fi
elif grep -R -n -E "codex-universal|ghcr\.io/openai/codex-universal" \
  "${CHART_DIR}/examples" \
  "${ROOT_DIR}/scripts/agents/native-workflow-e2e.sh"; then
  echo "Agents examples must use the chart-managed agents-codex-runner image, not codex-universal." >&2
  exit 1
fi

curl_with_retry() {
  curl \
    --connect-timeout 20 \
    --max-time 120 \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 5 \
    -fsSL \
    "$@"
}

run_with_helm3() {
  # kustomize --enable-helm is not compatible with Helm v4 yet; prefer Helm v3.
  #
  # Primary: use an already-installed Helm v3 on PATH (works in CI containers).
  # Fallback: use mise to provide Helm v3 when it can install it.
  if command -v helm >/dev/null 2>&1; then
    if helm version --short 2>/dev/null | grep -qE '^v3\.'; then
      "$@"
      return $?
    fi
  fi
  if command -v mise >/dev/null 2>&1; then
    mise exec helm@3 -- "$@"
    return $?
  fi
  "$@"
}

go generate "${ROOT_DIR}/services/agents/api"

git -C "${ROOT_DIR}" diff --exit-code -- "${CHART_DIR}/crds" \
  "${ROOT_DIR}/services/agents/api"

run_with_helm3 helm lint --kube-version "${KUBE_VERSION_FOR_HELM}" "${CHART_DIR}"

chart_version="$(awk -F': *' '$1 == "version" {print $2; exit}' "${CHART_DIR}/Chart.yaml" | sed "s/[\"']//g")"
artifacthub_version="$(awk -F': *' '$1 == "version" {print $2; exit}' "${CHART_DIR}/artifacthub-pkg.yml" | sed "s/[\"']//g")"
if [[ -z "${chart_version}" || -z "${artifacthub_version}" || "${chart_version}" != "${artifacthub_version}" ]]; then
  echo "artifacthub-pkg.yml version (${artifacthub_version:-missing}) must match Chart.yaml (${chart_version:-missing})." >&2
  exit 1
fi

render_and_check() {
  local values_file="$1"
  local output
  output="$(mktemp)"
  run_with_helm3 helm template "${CHART_DIR}" --kube-version "${KUBE_VERSION_FOR_HELM}" --values "${values_file}" >"${output}"

  if command -v rg >/dev/null 2>&1; then
    if rg -n "^kind: (Ingress|StatefulSet|CronJob|PersistentVolumeClaim)" "${output}"; then
      echo "Disallowed resources found in rendered chart (${values_file})" >&2
      exit 1
    fi
    return 0
  fi

  if grep -nE "^kind: (Ingress|StatefulSet|CronJob|PersistentVolumeClaim)" "${output}"; then
    echo "Disallowed resources found in rendered chart (${values_file})" >&2
    exit 1
  fi
}

render_and_check "${CHART_DIR}/values-dev.yaml"
render_and_check "${CHART_DIR}/values-local.yaml"
render_and_check "${CI_VALUES_FILE}"
render_and_check "${CHART_DIR}/values-prod.yaml"

control_plane_nats_render="$(mktemp)"
run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set controllers.enabled=true \
  --set agentComms.enabled=true >"${control_plane_nats_render}"
python3 - "${control_plane_nats_render}" <<'PY'
import sys
import yaml

render_path = sys.argv[1]
with open(render_path, encoding="utf-8") as handle:
    docs = list(yaml.safe_load_all(handle))

def find_deployment(name: str):
    return next(
        (
            doc
            for doc in docs
            if isinstance(doc, dict)
            and doc.get("kind") == "Deployment"
            and doc.get("metadata", {}).get("name") == name
        ),
        None,
    )


def first_container_env(deployment: dict, label: str):
    containers = deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if not containers:
        print(f"Rendered {label} Deployment has no containers.", file=sys.stderr)
        sys.exit(1)

    env = {}
    names = []
    for entry in containers[0].get("env", []):
        if isinstance(entry, dict) and isinstance(entry.get("name"), str):
            names.append(entry["name"])
            env[entry["name"]] = entry.get("value")
    return env, names


deployment = find_deployment("release-name-agents")
if deployment is None:
    print("Rendered agents control-plane Deployment was not found.", file=sys.stderr)
    sys.exit(1)

controllers_deployment = find_deployment("release-name-agents-controllers")
if controllers_deployment is None:
    print("Rendered agents controllers Deployment was not found.", file=sys.stderr)
    sys.exit(1)

control_plane_env, control_plane_env_names = first_container_env(deployment, "agents control-plane")
controllers_env, _controllers_env_names = first_container_env(controllers_deployment, "agents controllers")

nats_url_count = control_plane_env_names.count("NATS_URL")
if nats_url_count != 1:
    message = (
        "Expected exactly one NATS_URL env var on the control-plane Deployment "
        "when agentComms is enabled and controllers own the subscriber; "
        f"found {nats_url_count}."
    )
    print(
        message,
        file=sys.stderr,
    )
    sys.exit(1)

expected_profiles = {
    "control-plane": (control_plane_env, "agents-control-plane"),
    "controllers": (controllers_env, "agents-controllers"),
}
for label, (env, expected) in expected_profiles.items():
    actual = env.get("AGENTS_SERVER_PROFILE")
    if actual != expected:
        print(
            f"Expected {label} AGENTS_SERVER_PROFILE={expected}, found {actual!r}.",
            file=sys.stderr,
        )
        sys.exit(1)
PY

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set imagePolicy.requireDigest=true >/dev/null 2>&1; then
  echo "imagePolicy.requireDigest=true should reject chart-managed images without digests." >&2
  exit 1
fi

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set imagePolicy.requireDigest=true \
  --set "image.digest=${DUMMY_IMAGE_DIGEST}" >/dev/null 2>&1; then
  echo "imagePolicy.requireDigest=true should reject runner images without digests." >&2
  exit 1
fi

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set imagePolicy.requireDigest=true \
  --set "image.digest=sha256:not-a-real-digest" \
  --set "runner.image.digest=${DUMMY_IMAGE_DIGEST}" >/dev/null 2>&1; then
  echo "imagePolicy.requireDigest=true should reject malformed image digests." >&2
  exit 1
fi

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set-string "env.vars.JANGAR_AGENT_RUNNER_IMAGE=registry.example/jangar-runner:legacy" >/dev/null 2>&1; then
  echo "Agents chart should reject non-canonical JANGAR_* env overrides." >&2
  exit 1
fi

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set-string "env.vars.AGENTS_AGENT_IMAGE=registry.example/agents-runner:legacy" >/dev/null 2>&1; then
  echo "Agents chart should reject the removed AGENTS_AGENT_IMAGE runner image alias." >&2
  exit 1
fi

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set imagePolicy.requireDigest=true \
  --set "image.digest=${DUMMY_IMAGE_DIGEST}" \
  --set "runner.image.digest=${DUMMY_IMAGE_DIGEST}" \
  --set argocdHooks.enabled=true \
  --set argocdHooks.preSync.enabled=true \
  --set "argocdHooks.smoke.labelSelector=agents.proompteng.ai/test=true" >/dev/null 2>&1; then
  echo "imagePolicy.requireDigest=true should reject Argo CD hook images without digests." >&2
  exit 1
fi

if run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set imagePolicy.requireDigest=true \
  --set "image.digest=${DUMMY_IMAGE_DIGEST}" \
  --set "runner.image.digest=${DUMMY_IMAGE_DIGEST}" \
  --set tests.enabled=true >/dev/null 2>&1; then
  echo "imagePolicy.requireDigest=true should reject Helm test images without digests." >&2
  exit 1
fi

test_render="$(mktemp)"
run_with_helm3 helm template "${CHART_DIR}" \
  --kube-version "${KUBE_VERSION_FOR_HELM}" \
  --values "${CHART_DIR}/values-local.yaml" \
  --set tests.enabled=true \
  --set "tests.image.digest=${TEST_IMAGE_DIGEST}" >"${test_render}"
if command -v rg >/dev/null 2>&1; then
  rg -q 'helm.sh/hook.*test' "${test_render}"
  rg -q 'name: .*test-connection' "${test_render}"
  rg -q 'curlimages/curl:8.11.1@sha256:' "${test_render}"
else
  grep -Eq 'helm.sh/hook.*test' "${test_render}"
  grep -Eq 'name: .*test-connection' "${test_render}"
  grep -Eq 'curlimages/curl:8.11.1@sha256:' "${test_render}"
fi

render_kustomize() {
  if command -v kustomize >/dev/null 2>&1; then
    run_with_helm3 kustomize build --enable-helm --helm-kube-version "${KUBE_VERSION_FOR_HELM}" "${ARGOCD_AGENTS_DIR}" >/dev/null
    return 0
  fi

  if command -v kubectl >/dev/null 2>&1; then
    run_with_helm3 kubectl kustomize --enable-helm --helm-kube-version "${KUBE_VERSION_FOR_HELM}" "${ARGOCD_AGENTS_DIR}" >/dev/null
    return 0
  fi

  echo "kustomize (or kubectl) is required to render ${ARGOCD_AGENTS_DIR}" >&2
  exit 1
}

render_kustomize

python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_agents.yaml" agents.proompteng.ai v1alpha1 Agent
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_agentruns.yaml" agents.proompteng.ai v1alpha1 AgentRun
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_agentproviders.yaml" agents.proompteng.ai v1alpha1 AgentProvider
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/agents.proompteng.ai_versioncontrolproviders.yaml" agents.proompteng.ai v1alpha1 VersionControlProvider
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
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/swarm.proompteng.ai_swarms.yaml" swarm.proompteng.ai v1alpha1 Swarm
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/artifacts.proompteng.ai_artifacts.yaml" artifacts.proompteng.ai v1alpha1 Artifact
python3 "${ROOT_DIR}/scripts/download_crd_schema.py" "${CHART_DIR}/crds/workspaces.proompteng.ai_workspaces.yaml" workspaces.proompteng.ai v1alpha1 Workspace

if ! git -C "${ROOT_DIR}" diff --exit-code -- "${ROOT_DIR}/schemas/custom"; then
  echo "schemas/custom is out of date; regenerate and commit the CRD schemas." >&2
  exit 1
fi

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

CRD_SCHEMA_VERSION="${KUBECONFORM_K8S_VERSION:-1.27.0}"
crd_schema_dir="$(mktemp -d)"
trap 'rm -rf "${crd_schema_dir}"' EXIT
crd_schema_base="https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v${CRD_SCHEMA_VERSION}-standalone-strict"
curl_with_retry -o "${crd_schema_dir}/_definitions.json" "${crd_schema_base}/_definitions.json"
python3 - "${crd_schema_dir}" <<'PY'
import json
import pathlib
import sys

base = pathlib.Path(sys.argv[1])
definitions = json.loads((base / "_definitions.json").read_text()).get("definitions", {})
schema = {
    "$schema": "http://json-schema.org/schema#",
    "definitions": definitions,
    "$ref": "#/definitions/io.k8s.apiextensions-apiserver.pkg.apis.apiextensions.v1.CustomResourceDefinition",
}
payload = json.dumps(schema)
for name in ("CustomResourceDefinition.json", "customresourcedefinition.json"):
    (base / name).write_text(payload)
PY

kubeconform --strict --summary \
  --schema-location "${crd_schema_dir}/{{.ResourceKind}}.json" \
  "${CHART_DIR}/crds"/*.yaml

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
