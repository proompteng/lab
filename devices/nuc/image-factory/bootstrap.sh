#!/usr/bin/env bash

set -Eeuo pipefail

image_factory_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly image_factory_dir
readonly env_file="$image_factory_dir/.env"

die() {
  echo "error: $*" >&2
  exit 1
}

for command in curl docker grep install ip jq openssl sudo; do
  command -v "$command" >/dev/null || die "required command is missing: $command"
done

[[ "$(uname -s)" == 'Linux' ]] || die 'Image Factory must be bootstrapped on the Linux NUC'
[[ "$(uname -m)" == 'x86_64' ]] || die 'the pinned Image Factory image requires an x86_64 NUC'
docker compose version >/dev/null

if [[ ! -e "$env_file" ]]; then
  install -m 0600 "$image_factory_dir/.env.example" "$env_file"
  echo "created $env_file"
fi

chmod 0600 "$env_file"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

readonly data_root="${IMAGE_FACTORY_DATA_ROOT:-/var/lib/image-factory}"
[[ "$data_root" == /* && "$data_root" != '/' ]] || die 'IMAGE_FACTORY_DATA_ROOT must be an absolute dedicated directory'

owner="${SUDO_USER:-$USER}"
group="$(id -gn "$owner")"
for directory in "$data_root" "$data_root/registry" "$data_root/secrets" "$data_root/tmp"; do
  sudo install -d -m 0700 -o "$owner" -g "$group" "$directory"
done

key_path="$data_root/secrets/cache-signing-key.key"
if [[ ! -s "$key_path" ]]; then
  umask 077
  openssl ecparam -name prime256v1 -genkey -noout -out "$key_path"
  echo "created Image Factory cache-signing key at $key_path"
fi
chmod 0600 "$key_path"

"$image_factory_dir/validate.sh"

docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" pull
docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" up -d

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error "http://${IMAGE_FACTORY_BIND_ADDRESS:-100.100.244.148}:8080/readyz" >/dev/null; then
    "$image_factory_dir/verify.sh"
    exit 0
  fi

  sleep 2
done

docker compose --env-file "$env_file" -f "$image_factory_dir/compose.yaml" logs --tail 100 image-factory >&2
die 'Image Factory did not become ready within 60 seconds'
