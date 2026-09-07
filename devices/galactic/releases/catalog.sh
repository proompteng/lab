#!/usr/bin/env bash

set -Eeuo pipefail

release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly release_dir
readonly lock="$release_dir/v1.14.0.json"
readonly identity='https://github.com/proompteng/lab/.github/workflows/kata-firecracker-extension.yaml@refs/heads/main'
readonly issuer='https://token.actions.githubusercontent.com'

[[ $# == 2 && ( "$1" == build || "$1" == publish ) ]] || {
  echo "usage: $0 <build|publish> <output-directory>" >&2
  exit 2
}
for command in crane cosign jq tar; do
  command -v "$command" >/dev/null
done

source_ref=$(jq -er .kataSource "$lock")
entry=$(jq -er .kataCatalogEntry "$lock")
upstream=$(jq -er .upstreamCatalog "$lock")
catalog=$(jq -er '.catalogRepository + ":" + .talos' "$lock")
readonly source_ref entry upstream catalog
[[ "$source_ref" =~ @sha256:[0-9a-f]{64}$ ]]
[[ "$entry" =~ :[^/@]+@sha256:[0-9a-f]{64}$ ]]
[[ "$upstream" =~ @sha256:[0-9a-f]{64}$ ]]
[[ "${entry##*@}" == "${source_ref##*@}" ]]

mkdir -p -- "$2"
output=$(cd -- "$2" && pwd)
readonly output

verify() {
  cosign verify --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" "$1"
}

if [[ "$1" == build ]]; then
  verify "$source_ref" >"$output/kata-signature.json"
  crane manifest "$source_ref" >"$output/kata-index.json"
  jq -e '
    ([.manifests[].platform | select(.os == "linux") | .architecture] | sort) == ["amd64", "arm64"]
  ' "$output/kata-index.json" >/dev/null
  "$release_dir/../extensions/kata/build-catalog.sh" "$upstream" "$entry" "$output"
  cp "$lock" "$output/release.json"
  exit 0
fi

[[ "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_REPOSITORY:-}" == proompteng/lab ]]
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
[[ -s "$output/catalog.tar" ]]
cmp "$lock" "$output/release.json"
verify "$source_ref" >"$output/kata-signature.json"

extension_tag=${entry%@*}
crane copy "$source_ref" "$extension_tag"
[[ "$(crane digest "$extension_tag")" == "${entry##*@}" ]]
cosign sign --yes "$entry"
verify "$entry" >"$output/published-kata-signature.json"

candidate="${catalog}-${GITHUB_SHA}"
crane append --new_layer "$output/catalog.tar" --new_tag "$candidate"
digest=$(crane digest "$candidate")
immutable="${catalog%:*}@$digest"
cosign sign --yes "$immutable"
verify "$immutable" >"$output/catalog-signature.json"

# Never change the catalog underneath an existing Talos-version installer cache.
crane ls "${catalog%:*}" >"$output/catalog-tags.txt"
if grep -Fxq "${catalog##*:}" "$output/catalog-tags.txt"; then
  [[ "$(crane digest "$catalog")" == "$digest" ]] || {
    echo "refusing to replace an existing catalog with different contents: $catalog" >&2
    exit 1
  }
else
  crane tag "$immutable" "${catalog##*:}"
fi
[[ "$(crane digest "$catalog")" == "$digest" ]]
jq -n --arg catalog "$immutable" --arg extension "$entry" --arg source "$GITHUB_SHA" \
  '{catalog: $catalog, extension: $extension, source: $source}' >"$output/published.json"
cat "$output/published.json"
