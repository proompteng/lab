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
  packages/scripts \
  argocd/applications/bayn \
  argocd/applications/torghut \
  argocd/applicationsets/product.yaml \
  nix .github patches \
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
