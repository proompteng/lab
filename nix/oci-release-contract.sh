#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: write-oci-release-contract <output-json>" >&2
  exit 2
fi

output_path="$1"

required_env=(IMAGE TAG DIGEST REFERENCE GITHUB_SHA PACKAGE_ATTR)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required" >&2
    exit 2
  fi
done

mkdir -p "$(dirname "${output_path}")"
jq -n \
  --arg image "${IMAGE}" \
  --arg tag "${TAG}" \
  --arg digest "${DIGEST}" \
  --arg reference "${REFERENCE}" \
  --arg sourceSha "${GITHUB_SHA}" \
  --arg packageAttr "${PACKAGE_ATTR}" \
  '{
    image: $image,
    tag: $tag,
    digest: $digest,
    reference: $reference,
    sourceSha: $sourceSha,
    packageAttr: $packageAttr,
    builder: "nix-dockerTools-skopeo"
  }' > "${output_path}"

cat "${output_path}"
