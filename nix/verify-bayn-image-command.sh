#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: verify-bayn-image-command <nix-image-tar>" >&2
  exit 2
fi

image_tar="$(readlink -f "$1")"
if [[ ! -f "${image_tar}" ]] || {
  [[ "${image_tar}" != /nix/store/* ]] && [[ "${BAYN_VERIFY_ALLOW_NON_NIX_ARCHIVE:-false}" != 'true' ]]
}; then
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

resolve_image_entry() {
  local logical_path="$1"
  local entry="${rootfs}${logical_path}"
  local target

  if [[ ! -e "${entry}" && ! -L "${entry}" ]]; then
    echo "Bayn image is missing ${logical_path}." >&2
    return 1
  fi
  if [[ ! -L "${entry}" ]]; then
    printf '%s\n' "${entry}"
    return 0
  fi

  target="$(readlink "${entry}")"
  if [[ "${target}" = /* ]]; then
    entry="${rootfs}${target}"
  else
    entry="$(dirname "${entry}")/${target}"
  fi
  if [[ ! -e "${entry}" ]]; then
    echo "Bayn image entry ${logical_path} targets missing in-image path ${target}." >&2
    return 1
  fi
  printf '%s\n' "${entry}"
}

forward_wrapper="$(resolve_image_entry /bin/bayn-forward-performance)"
forward_command="$(resolve_image_entry /app/services/bayn/dist/forward-performance-command.js)"
execution_server="$(resolve_image_entry /app/services/bayn/dist/restate-execution-server.js)"
image_node="$(resolve_image_entry /bin/node)"

test -x "${forward_wrapper}"
test -f "${forward_command}"
test -f "${execution_server}"
test -x "${image_node}"
grep -F 'exec "$root/bin/node" "$root/app/services/bayn/dist/forward-performance-command.js" "$@"' \
  "${forward_wrapper}" >/dev/null

host_node="$(command -v node)"
if [[ -z "${host_node}" ]]; then
  echo 'Bayn image command verification requires Node.js on the verifier host.' >&2
  exit 1
fi

actual="$(NODE_ENV=production "${host_node}" "${forward_command}" --help)"
expected='Usage: bayn-forward-performance [--help]'
if [[ "${actual}" != "${expected}" ]]; then
  printf 'Unexpected Bayn forward-performance help output:\n%s\n' "${actual}" >&2
  exit 1
fi

printf '%s\n' "${actual}"
