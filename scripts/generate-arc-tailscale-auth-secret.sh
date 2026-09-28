#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ "${1:-}" == -* ]]; then
  echo "Unknown flag '$1'. Pass an optional output path or nothing." >&2
  exit 1
fi

OUTPUT_PATH="${1:-$REPO_ROOT/argocd/applications/arc/tailscale-auth.yaml}"

DEFAULT_OP_TAILSCALE_AUTH_PATH='op://infra/tailscale auth key/authkey'
OP_TAILSCALE_AUTH_PATH="${ARC_TAILSCALE_AUTHKEY_OP_PATH:-$DEFAULT_OP_TAILSCALE_AUTH_PATH}"

SEALED_CONTROLLER_NAME="${ARC_SEALED_CONTROLLER_NAME:-sealed-secrets}"
SEALED_CONTROLLER_NAMESPACE="${ARC_SEALED_CONTROLLER_NAMESPACE:-sealed-secrets}"

SECRET_NAME="tailscale-auth"
SECRET_NAMESPACE="arc"
SECRET_KEY="TS_AUTHKEY"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required CLI '$1' is not available in PATH" >&2
    exit 1
  fi
}

require op
require kubectl
require kubeseal

TS_AUTHKEY="$(op read "$OP_TAILSCALE_AUTH_PATH" | tr -d '\r\n')"

if [[ -z "$TS_AUTHKEY" ]]; then
  echo "Tailscale auth key is empty. Check 1Password path: $OP_TAILSCALE_AUTH_PATH" >&2
  exit 1
fi

TMP_OUTPUT="$(mktemp)"
trap 'rm -f "$TMP_OUTPUT"' EXIT

if ! kubectl create secret generic "$SECRET_NAME" \
  --namespace "$SECRET_NAMESPACE" \
  --from-literal="$SECRET_KEY=$TS_AUTHKEY" \
  --dry-run=client -o yaml |
  kubeseal \
    --controller-name "$SEALED_CONTROLLER_NAME" \
    --controller-namespace "$SEALED_CONTROLLER_NAMESPACE" \
    --format yaml >"$TMP_OUTPUT"; then
  echo "Failed to generate sealed secret" >&2
  exit 1
fi

if ! grep -q "$SECRET_KEY:" "$TMP_OUTPUT"; then
  echo "kubeseal output missing expected encrypted field '$SECRET_KEY'" >&2
  exit 1
fi

install -m 600 "$TMP_OUTPUT" "$OUTPUT_PATH"

echo "SealedSecret written to $OUTPUT_PATH. Commit and sync arc to roll out the new auth key."
