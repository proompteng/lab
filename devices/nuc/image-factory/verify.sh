#!/usr/bin/env bash

set -Eeuo pipefail

image_factory_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly image_factory_dir
readonly env_file="$image_factory_dir/.env"

die() {
  echo "error: $*" >&2
  exit 1
}

for command in curl docker jq; do
  command -v "$command" >/dev/null || die "required command is missing: $command"
done

[[ -s "$env_file" ]] || die "missing $env_file; run bootstrap.sh"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

readonly base_url="http://${IMAGE_FACTORY_BIND_ADDRESS:-100.100.244.148}:${IMAGE_FACTORY_BIND_PORT:-8081}"
readonly -a curl_args=(--connect-timeout 5 --fail --silent --show-error)

docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" ps --status running --quiet registry | grep -q .
docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" ps --status running --quiet image-factory | grep -q .

curl "${curl_args[@]}" --max-time 15 "$base_url/healthz" >/dev/null
curl "${curl_args[@]}" --max-time 15 "$base_url/readyz" >/dev/null
curl "${curl_args[@]}" --max-time 15 "$base_url/v2/" >/dev/null
curl "${curl_args[@]}" --max-time 60 "$base_url/versions" \
  | jq -e 'index("v1.13.9") != null' >/dev/null

extensions="$(curl "${curl_args[@]}" --max-time 60 "$base_url/version/v1.13.9/extensions/official")"
extension_digest="$(
  jq -er '.[] | select(.name == "proompteng/talos-kata-runtimes") | .digest' <<<"$extensions"
)"

schematic="$(
  curl "${curl_args[@]}" --max-time 300 \
    -H 'Content-Type: application/yaml' \
    --data-binary $'customization:\n  systemExtensions:\n    officialExtensions:\n      - proompteng/talos-kata-runtimes\n' \
    "$base_url/schematics"
)"
jq -e '.id | test("^[0-9a-f]{64}$")' <<<"$schematic" >/dev/null
schematic_id="$(jq -er .id <<<"$schematic")"

installer_index="$(
  curl "${curl_args[@]}" --max-time 900 \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "$base_url/v2/metal-installer/$schematic_id/manifests/v1.13.9"
)"
jq -e '
  .schemaVersion == 2
  and ([.manifests[].platform | select(.os == "linux") | .architecture] | sort) == ["amd64", "arm64"]
' <<<"$installer_index" >/dev/null

echo "Image Factory is ready; Kata extension digest: $extension_digest; smoke installer: $schematic_id"
