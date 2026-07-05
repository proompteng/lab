#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: write-oci-release-contract <output-json>" >&2
  exit 2
fi

output_path="$1"

required_env=(
  SERVICE
  IMAGE
  TAG
  DIGEST
  REFERENCE
  GITHUB_SHA
  PACKAGE_ATTR
  PLATFORMS
  PLATFORM_DIGEST_AMD64
  PLATFORM_DIGEST_ARM64
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required" >&2
    exit 2
  fi
done

lockfile_hashes="$(jq -n '{}')"
for lockfile in flake.lock bun.lock; do
  if [[ -f "${lockfile}" ]]; then
    hash="$(sha256sum "${lockfile}" | awk '{print $1}')"
    lockfile_hashes="$(jq --arg path "${lockfile}" --arg hash "${hash}" '. + {($path): $hash}' <<< "${lockfile_hashes}")"
  fi
done

tool_versions="$(
  jq -n \
    --arg nix "$(nix --version 2>/dev/null || true)" \
    --arg skopeo "$(skopeo --version 2>/dev/null || true)" \
    --arg crane "$(crane version 2>/dev/null || true)" \
    '{nix: $nix, skopeo: $skopeo, crane: $crane} | with_entries(select(.value != ""))'
)"

mkdir -p "$(dirname "${output_path}")"
jq -n \
  --arg service "${SERVICE}" \
  --arg image "${IMAGE}" \
  --arg tag "${TAG}" \
  --arg digest "${DIGEST}" \
  --arg reference "${REFERENCE}" \
  --arg sourceSha "${GITHUB_SHA}" \
  --arg packageAttr "${PACKAGE_ATTR}" \
  --arg platforms "${PLATFORMS}" \
  --arg platformDigestAmd64 "${PLATFORM_DIGEST_AMD64}" \
  --arg platformDigestArm64 "${PLATFORM_DIGEST_ARM64}" \
  --argjson lockfileHashes "${lockfile_hashes}" \
  --argjson toolVersions "${tool_versions}" \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    service: $service,
    image: $image,
    tag: $tag,
    digest: $digest,
    reference: $reference,
    sourceSha: $sourceSha,
    packageAttr: $packageAttr,
    platforms: ($platforms | split(",") | map(select(length > 0))),
    platformDigests: {
      "linux/amd64": $platformDigestAmd64,
      "linux/arm64": $platformDigestArm64
    },
    lockfileHashes: $lockfileHashes,
    toolVersions: $toolVersions,
    builder: "nix-dockerTools-skopeo",
    invocation: "github-actions",
    createdAt: $createdAt
  }' > "${output_path}"

cat "${output_path}"
