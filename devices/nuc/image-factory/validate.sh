#!/usr/bin/env bash

set -Eeuo pipefail

image_factory_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly image_factory_dir
readonly env_file="$image_factory_dir/.env"

die() {
  echo "error: $*" >&2
  exit 1
}

for command in docker grep ip openssl; do
  command -v "$command" >/dev/null || die "required command is missing: $command"
done

[[ -s "$env_file" ]] || die "missing $env_file; run bootstrap.sh"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

readonly bind_address="${IMAGE_FACTORY_BIND_ADDRESS:-100.100.244.148}"
readonly data_root="${IMAGE_FACTORY_DATA_ROOT:-/var/lib/image-factory}"
[[ "$bind_address" == '100.100.244.148' ]] || die 'Image Factory must bind the NUC Elauwit provider-LAN address'
[[ "$data_root" == /* && "$data_root" != '/' ]] || die 'IMAGE_FACTORY_DATA_ROOT must be an absolute dedicated directory'
ip -4 -brief address | grep -Eq '(^|[[:space:]])100\.100\.244\.148/25([[:space:]]|$)' \
  || die "$bind_address/25 is not configured on this host"

key_path="$data_root/secrets/cache-signing-key.key"
[[ -s "$key_path" ]] || die 'cache-signing key is missing; run bootstrap.sh'
openssl ec -check -noout -in "$key_path" >/dev/null 2>&1 || die 'cache-signing key is invalid'

grep -Eq '^[[:space:]]+extensionManifest: proompteng/talos-extensions$' "$image_factory_dir/config.yaml"
grep -Eq '^[[:space:]]+externalURL: http://100\.100\.244\.148:8080/$' "$image_factory_dir/config.yaml"
if grep -Eq '^[[:space:]]+disabled: true$' "$image_factory_dir/config.yaml"; then
  die 'container signature verification must stay enabled'
fi

docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" config --quiet
echo 'Image Factory configuration validation passed'
