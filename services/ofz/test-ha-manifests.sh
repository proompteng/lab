#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ofz_ha_output=$(mktemp -d)
trap 'rm -rf "$ofz_ha_output"' EXIT
for target in tengri proompteng keycloak ofz cloudflare; do
  source="argocd/applications/$target"
  kustomize build "$source" >"$ofz_ha_output/$target.yaml"
  bash scripts/kubeconform.sh "$ofz_ha_output/$target.yaml"
  yq eval-all -o=json -I=0 '[.]' "$ofz_ha_output/$target.yaml" >"$ofz_ha_output/$target.json"
done
yq eval-all -o=json -I=0 '[.]' services/tengri/crd.yaml >"$ofz_ha_output/crd.json"
python3 services/ofz/tests/ha_manifests.py "$ofz_ha_output"
