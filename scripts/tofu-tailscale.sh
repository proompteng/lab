#!/usr/bin/env bash
set -euo pipefail

ITEM_PATH="${TAILSCALE_OP_ITEM_PATH:-op://Infra/Tailscale TF/password}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if ! command -v op >/dev/null 2>&1; then
  echo "1Password CLI 'op' is required but not found in PATH." >&2
  exit 1
fi

if ! command -v tofu >/dev/null 2>&1; then
  echo "OpenTofu CLI 'tofu' is required but not found in PATH." >&2
  exit 1
fi

TAILSCALE_KEY="$(op read "$ITEM_PATH" | tr -d '\r\n')"
if [[ -z "$TAILSCALE_KEY" ]]; then
  echo "Failed to read Tailscale API key from 1Password item: $ITEM_PATH" >&2
  exit 1
fi

export TF_VAR_tailscale_api_key="$TAILSCALE_KEY"
cd "$REPO_ROOT/tofu/tailscale"

if [[ $# -eq 0 ]]; then
  set -- plan
fi

tofu "$@"

unset TF_VAR_tailscale_api_key
