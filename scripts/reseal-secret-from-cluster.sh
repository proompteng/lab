#!/usr/bin/env bash
set -euo pipefail

# Usage: reseal-secret-from-cluster.sh <namespace> <name> <output-file>
# Fetches an existing Secret from the cluster and emits a sealed-secret manifest.

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <namespace> <name> <output-file>" >&2
  exit 1
fi

namespace=$1
name=$2
output=$3

kubectl get secret "$name" \
  --namespace "$namespace" \
  -o yaml \
  | kubeseal \
      --controller-name=sealed-secrets \
      --controller-namespace=sealed-secrets \
      --format=yaml \
  > "$output"

echo "Sealed secret written to $output" >&2
