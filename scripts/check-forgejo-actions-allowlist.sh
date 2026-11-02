#!/usr/bin/env bash
set -euo pipefail

workflow_dir="${1:-.forgejo/workflows}"
allowlist_file="${2:-argocd/applications/forgejo-runners/actions-allowlist.txt}"

if [[ ! -f "$allowlist_file" ]]; then
  echo "allowlist file not found: $allowlist_file" >&2
  exit 1
fi

if [[ ! -d "$workflow_dir" ]]; then
  echo "workflow directory not found: $workflow_dir" >&2
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required" >&2
  exit 1
fi

allowlist=()
while IFS= read -r item; do
  allowlist+=("$item")
done < <(rg -v '^(\s*#|\s*$)' "$allowlist_file")
if [[ ${#allowlist[@]} -eq 0 ]]; then
  echo "allowlist is empty: $allowlist_file" >&2
  exit 1
fi

is_allowed_repo() {
  local repo="$1"
  local item
  for item in "${allowlist[@]}"; do
    [[ "$repo" == "$item" ]] && return 0
  done
  return 1
}

failed=0

while IFS= read -r -d '' file; do
  while IFS= read -r line; do
    ref="$(sed -E 's/^[[:space:]]*-[[:space:]]*uses:[[:space:]]*//; s/^[[:space:]]*uses:[[:space:]]*//' <<<"$line")"
    ref="${ref//\"/}"
    ref="${ref//\'/}"

    [[ -z "$ref" ]] && continue
    [[ "$ref" == ./* ]] && continue

    if [[ ! "$ref" =~ ^[^@]+@[0-9a-fA-F]{40}$ ]]; then
      echo "ERROR: $file uses non-SHA action ref: $ref" >&2
      failed=1
      continue
    fi

    repo="${ref%@*}"
    if ! is_allowed_repo "$repo"; then
      echo "ERROR: $file uses action not in allowlist: $repo" >&2
      failed=1
    fi
  done < <(rg '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^[:space:]]+' "$file")
done < <(find "$workflow_dir" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)

if [[ "$failed" -ne 0 ]]; then
  echo "Forgejo action policy check failed." >&2
  exit 1
fi

echo "Forgejo action policy check passed."
