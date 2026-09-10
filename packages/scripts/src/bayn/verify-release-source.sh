#!/usr/bin/env bash
set -euo pipefail

source_sha="${1:?expected the built source commit}"
deployed_manifest="${2:-}"
if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Expected a full built source commit SHA' >&2
  exit 1
fi
main_sha="$(git rev-parse --verify "refs/remotes/origin/main^{commit}")"
git merge-base --is-ancestor "$source_sha" "$main_sha"

# Unrelated monorepo commits may land while an image builds. A later change to
# Bayn, its desired state, or shared build inputs still requires a new image.
if ! git diff --quiet "$source_sha" "$main_sha" -- \
  services/bayn \
  packages/scripts/src/bayn \
  packages/scripts/src/shared/__tests__/bayn-cnpg-contract.test.ts \
  argocd/applications/bayn \
  argocd/applications/torghut/clickhouse \
  argocd/applicationsets/product.yaml \
  nix/images/bayn.nix \
  nix/images/bayn-runtime-root.nix \
  nix/images/bun-workspace-service.nix \
  nix/images/bun-workspace-deps-source.nix \
  nix/images/bun-workspace-deps-source.test.sh \
  nix/packages.nix \
  nix/cache-push.sh \
  nix/ci-nix-oci-summary.sh \
  nix/ci-run-timed.sh \
  nix/oci-inspect-archive.sh \
  nix/oci-push.sh \
  nix/oci-release-contract.sh \
  nix/verify-bayn-image-command.sh \
  nix/verify-bayn-image-command.test.sh \
  .github/actions/setup-nix-toolchain \
  ':(glob).github/workflows/bayn-*.yml' \
  .github/workflows/common-monorepo.yml \
  .github/workflows/nix-oci-build-common.yml \
  patches \
  flake.nix flake.lock bun.lock package.json ':(glob)**/package.json' \
  .npmrc bunfig.toml tsconfig.base.json; then
  echo 'Bayn source, configuration, or build inputs changed after this image was built' >&2
  exit 1
fi

if [[ -n "$deployed_manifest" ]]; then
  deployed_source="$(awk '
    $0 == "            - name: BAYN_CODE_REVISION" {
      count += 1
      getline
      sub(/^              value: /, "")
      value = $0
    }
    END {
      if (count != 1 || value == "") exit 1
      gsub(/^"|"$/, "", value)
      print value
    }
  ' "$deployed_manifest")"
  if ! [[ "$deployed_source" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Expected a full deployed source commit SHA' >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$deployed_source" "$source_sha"; then
    echo 'The deployed Bayn source is newer than or diverges from this image' >&2
    exit 1
  fi
fi
