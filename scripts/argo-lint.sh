#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"
FOUND=0
STATUS=0
WORKFLOW_DIRS="$(mktemp)"
trap 'rm -f "$WORKFLOW_DIRS"' EXIT
SEARCH_ROOTS=("$ROOT_DIR")

if [[ "$#" -eq 0 && -d "$ROOT_DIR/argocd" ]]; then
  SEARCH_ROOTS=("$ROOT_DIR/argocd")
  if [[ -d "$ROOT_DIR/kubernetes" ]]; then
    SEARCH_ROOTS+=("$ROOT_DIR/kubernetes")
  fi
fi

for search_root in "${SEARCH_ROOTS[@]}"; do
  if command -v rg >/dev/null 2>&1; then
    while IFS= read -r -d '' file; do
      FOUND=1
      dirname "$file" >> "$WORKFLOW_DIRS"
    done < <(
      rg -l -0 \
        --glob '*.yaml' \
        --glob '!**/.git/**' \
        --glob '!**/node_modules/**' \
        --glob '!**/dist/**' \
        --glob '!**/build/**' \
        --glob '!**/.next/**' \
        --glob '!**/.turbo/**' \
        --glob '!**/.venv/**' \
        --glob '!**/__pycache__/**' \
        '^(kind|  kind):\s*(Workflow|WorkflowTemplate|CronWorkflow)' \
        "$search_root"
    )
  else
    while IFS= read -r -d '' file; do
      if grep -Eq '^(kind|  kind):\s*(Workflow|WorkflowTemplate|CronWorkflow)' "$file"; then
        FOUND=1
        dirname "$file" >> "$WORKFLOW_DIRS"
      fi
    done < <(
      find "$search_root" \
        \( -type d \( \
          -name .git -o -name node_modules -o -name dist -o -name build -o \
          -name .next -o -name .turbo -o -name .venv -o -name __pycache__ \
        \) -prune \) \
        -o \( -type f -name '*.yaml' -print0 \)
    )
  fi
done

if [[ "$FOUND" -eq 0 ]]; then
  echo "No Argo Workflow manifests detected under $ROOT_DIR" >&2
fi

while IFS= read -r dir; do
  echo "::group::argo lint $dir"
  if ! argo lint --offline "$dir"; then
    STATUS=1
  fi
  echo "::endgroup::"
done < <(sort -u "$WORKFLOW_DIRS")

exit "$STATUS"
