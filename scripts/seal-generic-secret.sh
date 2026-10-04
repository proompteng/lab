#!/usr/bin/env bash
set -euo pipefail

# Usage: seal-generic-secret.sh <namespace> <name> <output-file> key=value [key=value...]
# Creates a generic secret from literal key/value pairs and seals it with kubeseal.

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <namespace> <name> <output-file> key=value [key=value...]" >&2
  exit 1
fi

namespace=$1
name=$2
output=$3
shift 3

controller_name=${SEALED_SECRETS_CONTROLLER_NAME:-sealed-secrets}
controller_namespace=${SEALED_SECRETS_CONTROLLER_NAMESPACE:-sealed-secrets}

args=(kubectl create secret generic "$name" --namespace "$namespace" --dry-run=client -o yaml)
for literal in "$@"; do
  if [[ $literal != *=* ]]; then
    echo "Invalid literal '$literal'; expected key=value" >&2
    exit 1
  fi
  args+=(--from-literal="$literal")
done

cert_file=
cleanup() {
  if [[ -n ${cert_file:-} && -f $cert_file ]]; then
    rm -f "$cert_file"
  fi
}
trap cleanup EXIT

active_key_name=$(
  kubectl get secret \
    --namespace "$controller_namespace" \
    --selector 'sealedsecrets.bitnami.com/sealed-secrets-key=active' \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
)

kubeseal_args=(--format=yaml)
if [[ -n $active_key_name ]]; then
  cert_file=$(mktemp)
  kubectl get secret "$active_key_name" \
    --namespace "$controller_namespace" \
    -o jsonpath='{.data.tls\.crt}' \
    | base64 -d > "$cert_file"
  kubeseal_args+=(--cert "$cert_file")
else
  kubeseal_args+=(--controller-name="$controller_name" --controller-namespace="$controller_namespace")
fi

"${args[@]}" | kubeseal "${kubeseal_args[@]}" > "$output"

echo "Sealed secret written to $output" >&2
