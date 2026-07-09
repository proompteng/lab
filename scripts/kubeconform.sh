#!/usr/bin/env bash
set -euo pipefail

PATHS=("$@")
if [[ ${#PATHS[@]} -eq 0 ]]; then
  PATHS=("argocd")
fi
SCHEMA_DIR="${PWD}/schemas/custom"
KUBECONFORM_CACHE_DIR="${KUBECONFORM_CACHE_DIR:-${PWD}/.cache/kubeconform}"

if ! command -v kubeconform >/dev/null 2>&1; then
  echo "kubeconform is required but not installed" >&2
  exit 1
fi

kustomizations=()
filtered=()
add_manifest_file() {
  local file="$1"
  case "$(basename "$file")" in
    kustomization.yaml | kustomization.yml)
      kustomizations+=("$file")
      return
      ;;
  esac
  if [[ "$file" == *"/charts/"* ]] || [[ "$file" == *".patch.yaml" ]]; then
    return
  fi
  if grep -Eq '^[[:space:]]*kind:' "$file"; then
    filtered+=("$file")
  fi
}

validate_kustomizations() {
  if [[ ${#kustomizations[@]} -eq 0 ]]; then
    return 0
  fi
  if ! command -v yq >/dev/null 2>&1; then
    echo "yq is required to parse changed kustomization files" >&2
    return 1
  fi
  local file
  for file in "${kustomizations[@]}"; do
    yq eval '.' "$file" >/dev/null
  done
}

for path in "${PATHS[@]}"; do
  if [[ -d "$path" ]]; then
    while IFS= read -r -d '' file; do
      add_manifest_file "$file"
    done < <(find "$path" -type f -name '*.yaml' -print0)
  elif [[ -f "$path" ]]; then
    case "$path" in
      *.yaml | *.yml)
        add_manifest_file "$path"
        ;;
    esac
  else
    echo "kubeconform input path does not exist: $path" >&2
    exit 1
  fi
done

if [[ ${#filtered[@]} -eq 0 ]]; then
  validate_kustomizations
  echo "No Kubernetes manifests with a kind key found in kubeconform inputs" >&2
  exit 0
fi

validate_kustomizations

SCHEMA_ARGS=()
if [[ -d "$SCHEMA_DIR" ]]; then
  SCHEMA_ARGS+=(
    "--schema-location" "${SCHEMA_DIR}/{{.ResourceKind}}{{.KindSuffix}}.json"
    "--schema-location" "${SCHEMA_DIR}/{{.Group}}_{{.ResourceAPIVersion}}_{{.ResourceKind}}.json"
    "--schema-location" "${SCHEMA_DIR}/{{.Group}}/{{.ResourceAPIVersion}}/{{.ResourceKind}}.json"
    "--schema-location" "${SCHEMA_DIR}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
    "--schema-location" "${SCHEMA_DIR}/{{.ResourceKind}}_{{.Group}}_{{.ResourceAPIVersion}}.json"
    "--schema-location" "${SCHEMA_DIR}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
  )
fi
SCHEMA_ARGS+=("--schema-location" "default")

KUBECONFORM_ARGS=(
  --strict
  --summary
  --ignore-missing-schemas
  --cache "${KUBECONFORM_CACHE_DIR}"
  -n "${KUBECONFORM_CONCURRENCY:-2}"
  # kubeconform v0.7.0 resolves Knative Service CRDs like native Service resources;
  # skipping the exact GVK avoids shadowing core Service validation with a CRD schema.
  --skip 'serving.knative.dev/v1/Service'
  --ignore-filename-pattern 'overlays/'
  --ignore-filename-pattern 'charts/'
  --ignore-filename-pattern 'Chart.yaml'
  --ignore-filename-pattern 'values.yaml'
  "${SCHEMA_ARGS[@]}"
)

mkdir -p "$KUBECONFORM_CACHE_DIR"

status=0
batch=()
batch_size=100
for file in "${filtered[@]}"; do
  batch+=("$file")
  if [[ ${#batch[@]} -ge $batch_size ]]; then
    kubeconform "${KUBECONFORM_ARGS[@]}" "${batch[@]}" || status=$?
    batch=()
  fi
done

if [[ ${#batch[@]} -gt 0 ]]; then
  kubeconform "${KUBECONFORM_ARGS[@]}" "${batch[@]}" || status=$?
fi

exit "$status"
