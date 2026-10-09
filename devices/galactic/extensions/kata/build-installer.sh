#!/usr/bin/env bash

set -euo pipefail

readonly IMAGER_IMAGE='ghcr.io/siderolabs/imager:v1.14.0@sha256:b4025bdc0aa3392d56997419457d4ca0cf81016c721de36d0128f7a519d11d5f'

usage() {
  echo "usage: $0 <ryzen-amd64|turin-amd64|altra-arm64> <kata-extension@sha256:digest> <output-dir>" >&2
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

readonly profile="$1"
readonly kata_extension="$2"
readonly requested_output_dir="$3"

if [[ "$kata_extension" != *@sha256:* ]]; then
  echo 'the Kata extension must be pinned by sha256 digest' >&2
  exit 2
fi

declare arch
declare -a official_extensions

case "$profile" in
  ryzen-amd64)
    arch='amd64'
    official_extensions=(
      'ghcr.io/siderolabs/amdgpu:20260810-v1.14.0@sha256:741b37c0a92fa6fb9178c5607668573081a3957e3143525efdc1265683430fc4'
      'ghcr.io/siderolabs/amd-ucode:20260810@sha256:2f846db3cfe189608ff2d4756243cf6c10f8592d4803c96a5aad6b72fa4e6a7b'
      'ghcr.io/siderolabs/glibc:2.43@sha256:396225a95a04983f882489ae37a9c8fc837a0c9d67c2ce99486d9c0e612f0ab9'
      'ghcr.io/siderolabs/tailscale:1.102.2@sha256:b84c796cc86125d2d0d09d526486bd0f1627ae39bcbfb97eb17d8b8205a5b857'
    )
    ;;
  turin-amd64 | nvidia-amd64)
    arch='amd64'
    official_extensions=(
      'ghcr.io/siderolabs/nvidia-container-toolkit-lts:580.178.04-v1.19.1@sha256:8c9e76b10e77564fea9868f63199553a7dc3d00bc6f3c5a6e5dedbd6f23d6e94'
      'ghcr.io/siderolabs/nvidia-open-gpu-kernel-modules-lts:580.178.04-v1.14.0@sha256:d695ca7ca68248272697bbdfd2f37532c30701d38862ffc960d24571e417f94c'
      'ghcr.io/siderolabs/tailscale:1.102.2@sha256:b84c796cc86125d2d0d09d526486bd0f1627ae39bcbfb97eb17d8b8205a5b857'
    )
    ;;
  altra-arm64 | nvidia-arm64)
    arch='arm64'
    official_extensions=(
      'ghcr.io/siderolabs/nvidia-container-toolkit-lts:580.178.04-v1.19.1@sha256:8c9e76b10e77564fea9868f63199553a7dc3d00bc6f3c5a6e5dedbd6f23d6e94'
      'ghcr.io/siderolabs/nvidia-open-gpu-kernel-modules-lts:580.178.04-v1.14.0@sha256:d695ca7ca68248272697bbdfd2f37532c30701d38862ffc960d24571e417f94c'
      'ghcr.io/siderolabs/tailscale:1.102.2@sha256:b84c796cc86125d2d0d09d526486bd0f1627ae39bcbfb97eb17d8b8205a5b857'
    )
    ;;
  *)
    usage
    exit 2
    ;;
esac

install -d "$requested_output_dir"
declare output_dir
output_dir="$(cd "$requested_output_dir" && pwd -P)"
readonly output_dir
readonly expected_output="$output_dir/installer-${arch}.tar"

declare -a docker_config_mount=()
readonly docker_config_dir="${DOCKER_CONFIG:-$HOME/.docker}"
if [[ -f "$docker_config_dir/config.json" ]]; then
  docker_config_mount=(-v "$docker_config_dir/config.json:/root/.docker/config.json:ro")
fi

declare -a imager_args=(
  installer
  --arch "$arch"
  --platform metal
  --output /out
  --system-extension-image "$kata_extension"
)

for extension in "${official_extensions[@]}"; do
  imager_args+=(--system-extension-image "$extension")
done

docker run --rm \
  "${docker_config_mount[@]}" \
  -v "$output_dir:/out" \
  "$IMAGER_IMAGE" \
  "${imager_args[@]}" >&2

if [[ ! -s "$expected_output" ]]; then
  echo "Talos imager did not create $expected_output" >&2
  exit 1
fi

printf '%s\n' "$expected_output"
