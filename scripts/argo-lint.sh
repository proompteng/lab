#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"
FOUND=0
STATUS=0
WORKFLOW_DIRS="$(mktemp)"
trap 'rm -f "$WORKFLOW_DIRS"' EXIT

while IFS= read -r -d '' file; do
  if grep -Eq '^(kind|  kind):\s*(Workflow|WorkflowTemplate|CronWorkflow)' "$file"; then
    FOUND=1
    dirname "$file" >> "$WORKFLOW_DIRS"
  fi
done < <(find "$ROOT_DIR" -type f -name '*.yaml' -print0)

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
