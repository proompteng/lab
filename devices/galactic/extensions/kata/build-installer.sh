#!/usr/bin/env bash

set -euo pipefail

readonly IMAGER_IMAGE='ghcr.io/siderolabs/imager:v1.13.9@sha256:bfeb72d58f918711f29f19337911ff845b7ce776cad17822149ac98e19751d55'

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
      'ghcr.io/siderolabs/amdgpu:20260810-v1.13.9@sha256:bb9911892eedb003d2da91cb4e12e2e1b8a7a3a794ad03daec57117d96467f3c'
      'ghcr.io/siderolabs/amd-ucode:20260810@sha256:2f846db3cfe189608ff2d4756243cf6c10f8592d4803c96a5aad6b72fa4e6a7b'
      'ghcr.io/siderolabs/glibc:2.43@sha256:e01587c3a86fcde9307457f4b3038b8f4f183c9908aa825f14ab5080a5602e4f'
      'ghcr.io/siderolabs/tailscale:1.102.2@sha256:bbcde50aaa3fe655f5d898a4c55ba0170c0ed14b80f26468b4f7d25d2283d1ef'
    )
    ;;
  turin-amd64 | nvidia-amd64)
    arch='amd64'
    official_extensions=(
      'ghcr.io/siderolabs/nvidia-container-toolkit-lts:580.178.04-v1.19.1@sha256:a009ea88645161ef780db5f86f1df4b64881f1abd779b021b1a4bab7bfb3e4bb'
      'ghcr.io/siderolabs/nvidia-open-gpu-kernel-modules-lts:580.178.04-v1.13.9@sha256:8a455dbe923e4eb5d4757b7c286fabcfabe2159204f96ff945a76632f28ad880'
      'ghcr.io/siderolabs/tailscale:1.102.2@sha256:bbcde50aaa3fe655f5d898a4c55ba0170c0ed14b80f26468b4f7d25d2283d1ef'
    )
    ;;
  altra-arm64 | nvidia-arm64)
    arch='arm64'
    official_extensions=(
      'ghcr.io/siderolabs/nvidia-container-toolkit-lts:580.178.04-v1.19.1@sha256:a009ea88645161ef780db5f86f1df4b64881f1abd779b021b1a4bab7bfb3e4bb'
      'ghcr.io/siderolabs/nvidia-open-gpu-kernel-modules-lts:580.178.04-v1.13.9@sha256:8a455dbe923e4eb5d4757b7c286fabcfabe2159204f96ff945a76632f28ad880'
      'ghcr.io/siderolabs/tailscale:1.102.2@sha256:bbcde50aaa3fe655f5d898a4c55ba0170c0ed14b80f26468b4f7d25d2283d1ef'
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
