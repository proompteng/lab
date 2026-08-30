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

contract_log_dirs=()
if [[ -n "${NIX_OCI_CONTRACT_LOG_DIRS:-}" ]]; then
  IFS=':' read -r -a contract_log_dirs <<< "${NIX_OCI_CONTRACT_LOG_DIRS}"
fi
if [[ -n "${NIX_OCI_LOG_DIR:-}" ]]; then
  contract_log_dirs+=("${NIX_OCI_LOG_DIR}")
fi

existing_contract_log_dirs=()
for log_dir in "${contract_log_dirs[@]}"; do
  if [[ -n "${log_dir}" && -d "${log_dir}" ]]; then
    existing_contract_log_dirs+=("${log_dir}")
  fi
done

log_dirs_json="$(
  if [[ "${#existing_contract_log_dirs[@]}" -eq 0 ]]; then
    jq -n '[]'
  else
    printf '%s\n' "${existing_contract_log_dirs[@]}" | jq -R -s 'split("\n") | map(select(length > 0))'
  fi
)"

count_log_matches() {
  local pattern="$1"
  local total count file
  total=0
  for log_dir in "${existing_contract_log_dirs[@]}"; do
    while IFS= read -r -d '' file; do
      count="$(grep -E -c "${pattern}" "${file}" 2>/dev/null || true)"
      total=$((total + count))
    done < <(find "${log_dir}" -type f -name '*.log' -print0)
  done
  echo "${total}"
}

timings_json="$(
  timing_files=()
  for log_dir in "${existing_contract_log_dirs[@]}"; do
    while IFS= read -r -d '' file; do
      timing_files+=("${file}")
    done < <(find "${log_dir}" -type f -name 'timings.tsv' -print0)
  done
  if [[ "${#timing_files[@]}" -eq 0 ]]; then
    jq -n '[]'
  else
    jq -R -s '
      split("\n")
      | map(select(length > 0) | split("\t"))
      | map({
          phase: .[0],
          status: (.[1] | tonumber? // .),
          seconds: (.[2] | tonumber? // 0),
          log: (.[3] // "")
        })
    ' "${timing_files[@]}"
  fi
)"

cache_provenance="$(
  jq -n \
    --arg source "github-actions-logs" \
    --argjson logDirs "${log_dirs_json}" \
    --argjson atticSubstitutions "$(count_log_matches "copying path .*from 'http://attic\\.attic\\.svc\\.cluster\\.local/lab'")" \
    --argjson cacheNixosSubstitutions "$(count_log_matches "copying path .*from 'https://cache\\.nixos\\.org'")" \
    --argjson localBuilds "$(count_log_matches "building '/nix/store/.*\\.drv'")" \
    --argjson plannedLocalBuildBlocks "$(count_log_matches 'this derivation will be built:|these [0-9]+ derivations will be built:')" \
    '{
      source: $source,
      logDirs: $logDirs,
      atticSubstitutions: $atticSubstitutions,
      cacheNixosSubstitutions: $cacheNixosSubstitutions,
      localBuilds: $localBuilds,
      plannedLocalBuildBlocks: $plannedLocalBuildBlocks
    }'
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
  --argjson cacheProvenance "${cache_provenance}" \
  --argjson timings "${timings_json}" \
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
    cacheProvenance: $cacheProvenance,
    timings: $timings,
    builder: "nix-dockerTools-skopeo",
    invocation: "github-actions",
    createdAt: $createdAt
  }' > "${output_path}"

cat "${output_path}"
