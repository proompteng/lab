#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: verify-bayn-image-command <nix-image-tar>" >&2
  exit 2
fi

image_tar="$(readlink -f "$1")"
if [[ ! -f "${image_tar}" ]] || [[ "${image_tar}" != /nix/store/* ]]; then
  echo "Bayn image command verification requires a Nix-store image archive: ${image_tar}" >&2
  exit 1
fi

work="$(mktemp -d)"
cleanup() {
  chmod -R u+rwX "${work}" 2>/dev/null || true
  rm -rf "${work}"
}
trap cleanup EXIT
archive="${work}/archive"
rootfs="${work}/rootfs"
mkdir -p "${archive}" "${rootfs}"
tar -xf "${image_tar}" -C "${archive}"

mapfile -t layers < <(jq -er '.[0].Layers[]' "${archive}/manifest.json")
if [[ "${#layers[@]}" -eq 0 ]]; then
  echo 'Bayn image archive contains no filesystem layers.' >&2
  exit 1
fi
for layer in "${layers[@]}"; do
  tar --no-same-owner -xf "${archive}/${layer}" -C "${rootfs}"
done

test -x "${rootfs}/bin/bayn-forward-performance"
test -f "${rootfs}/app/services/bayn/dist/forward-performance-command.js"
test -x "${rootfs}/bin/node"

actual="$(BAYN_IMAGE_ROOT="${rootfs}" NODE_ENV=production "${rootfs}/bin/bayn-forward-performance" --help)"
expected='Usage: bayn-forward-performance [--help]'
if [[ "${actual}" != "${expected}" ]]; then
  printf 'Unexpected Bayn forward-performance help output:\n%s\n' "${actual}" >&2
  exit 1
fi

printf '%s\n' "${actual}"
