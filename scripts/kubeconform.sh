#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-argocd}"
SCHEMA_DIR="${PWD}/schemas/custom"

if ! command -v kubeconform >/dev/null 2>&1; then
  echo "kubeconform is required but not installed" >&2
  exit 1
fi

filtered=()
while IFS= read -r -d '' file; do
  if [[ "$file" == *"/charts/"* ]] || [[ "$file" == *".patch.yaml" ]]; then
    continue
  fi
  if grep -Eq '^[[:space:]]*kind:' "$file"; then
    filtered+=("$file")
  fi
done < <(find "$ROOT_DIR" -type f -name '*.yaml' -print0)

if [[ ${#filtered[@]} -eq 0 ]]; then
  echo "No Kubernetes manifests with a kind key found under $ROOT_DIR" >&2
  exit 0
fi

SCHEMA_ARGS=("--schema-location" "default")
if [[ -d "$SCHEMA_DIR" ]]; then
  SCHEMA_ARGS+=("--schema-location" "file://${SCHEMA_DIR}/{{.Group}}_{{.ResourceAPIVersion}}_{{.ResourceKind}}.json")
fi

kubeconform --strict --summary --ignore-missing-schemas \
  --ignore-filename-pattern 'overlays/' \
  --ignore-filename-pattern 'charts/' \
  --ignore-filename-pattern 'Chart.yaml' \
  --ignore-filename-pattern 'values.yaml' \
  "${SCHEMA_ARGS[@]}" \
  "${filtered[@]}"
