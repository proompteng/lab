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

docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" ps --status running --quiet registry | grep -q .
docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" ps --status running --quiet image-factory | grep -q .

curl --fail --silent --show-error "$base_url/healthz" >/dev/null
curl --fail --silent --show-error "$base_url/readyz" >/dev/null
curl --fail --silent --show-error "$base_url/v2/" >/dev/null
curl --fail --silent --show-error "$base_url/versions" \
  | jq -e 'index("v1.13.9") != null' >/dev/null

extensions="$(curl --fail --silent --show-error "$base_url/version/v1.13.9/extensions/official")"
extension_digest="$(
  jq -er '.[] | select(.name == "proompteng/talos-kata-runtimes") | .digest' <<<"$extensions"
)"

schematic="$(
  curl --fail --silent --show-error \
    -H 'Content-Type: application/yaml' \
    --data-binary $'customization:\n  systemExtensions:\n    officialExtensions:\n      - proompteng/talos-kata-runtimes\n' \
    "$base_url/schematics"
)"
jq -e '.id | test("^[0-9a-f]{64}$")' <<<"$schematic" >/dev/null

echo "Image Factory is ready; Kata extension digest: $extension_digest; smoke schematic: $(jq -r .id <<<"$schematic")"
