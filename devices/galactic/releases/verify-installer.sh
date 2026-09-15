#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
receipt="$release_dir/talos-v1.14.0.json"
release_lock="$release_dir/../../nuc/image-factory/release.json"
profile="${1:?usage: verify-installer.sh <ryzen|turin|altra> <evidence-directory>}"
evidence_dir="${2:?provide an evidence directory}"

die() { echo "error: $*" >&2; exit 1; }
for tool in curl jq crane cosign; do
  command -v "$tool" >/dev/null || die "missing required command: $tool"
done
jq -e --arg profile "$profile" '.profiles | has($profile)' "$receipt" >/dev/null \
  || die "unknown node profile: $profile"
umask 077
mkdir -p -- "$evidence_dir"
factory="$(jq -er .factory "$receipt")"
talos_version="$(jq -er .talosVersion "$receipt")"
catalog="$(jq -er .catalog "$receipt")"
kata="$(jq -er .kataExtension "$receipt")"
identity="$(jq -er .signingIdentity "$receipt")"
schematic="$(jq -er --arg p "$profile" '.profiles[$p].schematic' "$receipt")"
index="$(jq -er --arg p "$profile" '.profiles[$p].indexDigest' "$receipt")"
platform="$(jq -er --arg p "$profile" '.profiles[$p].platformDigest' "$receipt")"
arch="$(jq -er --arg p "$profile" '.profiles[$p].architecture' "$receipt")"
repository="${factory#http://}/metal-installer/$schematic"

jq -e --arg version "$talos_version" --arg catalog "$catalog" --arg kata "$kata" \
  '.talos == $version and (.catalogRepository + "@" + .catalogDigest) == $catalog
   and .kataCatalogEntry == $kata' "$release_lock" >/dev/null \
  || die 'installer receipt differs from the release lock'
jq -e --arg p "$profile" --arg digest "${kata##*@}" \
  '.profiles[$p] | (.factoryRequestId | length > 0)
   and (.extensionDigests | index($digest) != null)' "$receipt" >/dev/null \
  || die 'factory build receipt does not contain the selected Kata input'

verify_signature() {
  cosign verify --certificate-identity "$identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$1" > "$2"
}
verify_signature "$catalog" "$evidence_dir/catalog-signature.json"
verify_signature "$kata" "$evidence_dir/kata-signature.json"
test "$(crane digest "${catalog%@*}:$talos_version")" = "${catalog##*@}" \
  || die 'published catalog tag differs from the release lock'
curl -fsS --connect-timeout 5 --max-time 30 \
  "$factory/version/$talos_version/extensions/official" > "$evidence_dir/catalog.json"
jq -e --arg digest "${kata##*@}" \
  '[.[] | select(.name == "proompteng/talos-kata-runtimes").digest] == [$digest]' \
  "$evidence_dir/catalog.json" >/dev/null || die 'factory resolves a different Kata extension'
curl -fsS --connect-timeout 5 --max-time 30 \
  "$factory/schematics/$schematic" > "$evidence_dir/schematic.yaml"
test "$(crane digest --insecure "$repository:$talos_version")" = "$index" \
  || die 'factory installer tag differs from the accepted index'
test "$(crane digest --insecure "$repository@$index")" = "$index" \
  || die 'immutable installer index digest mismatch'
crane manifest --insecure "$repository@$index" > "$evidence_dir/index.json"
jq -e --arg arch "$arch" --arg digest "$platform" \
  '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch).digest] == [$digest]' \
  "$evidence_dir/index.json" >/dev/null || die 'installer platform digest mismatch'
crane config --insecure "$repository@$platform" > "$evidence_dir/config.json"
jq -e --arg arch "$arch" '.os == "linux" and .architecture == $arch' \
  "$evidence_dir/config.json" >/dev/null || die 'installer architecture mismatch'
jq --arg p "$profile" '.profiles[$p]' "$receipt" > "$evidence_dir/receipt.json"
printf 'Verified %s: %s@%s (%s)\n' "$profile" "$repository" "$index" "$arch"
