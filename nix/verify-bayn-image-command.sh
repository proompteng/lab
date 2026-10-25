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
cost_wrapper="$(resolve_image_entry /bin/bayn-inference-cost)"
cost_command="$(resolve_image_entry /app/services/bayn/dist/inference-cost-command.js)"
research_wrapper="$(resolve_image_entry /bin/bayn-research)"
research_command="$(resolve_image_entry /app/services/bayn/dist/research-command.js)"
gepa_wrapper="$(resolve_image_entry /bin/bayn-gepa)"
gepa_runner="$(resolve_image_entry /app/services/bayn/gepa/runner.py)"
evaluation_wrapper="$(resolve_image_entry /bin/bayn-jev-evaluate)"
evaluation_command="$(resolve_image_entry /app/services/bayn/dist/jev-evaluation-command.js)"
gepa_native_wrapper="$(resolve_image_entry /bin/bayn-gepa-native)"
gepa_native_runner="$(resolve_image_entry /app/services/bayn/gepa/native.py)"
backtest_wrapper="$(resolve_image_entry /bin/bayn-backtest)"
backtest_command="$(resolve_image_entry /app/services/bayn/dist/backtest-command.js)"
research_server="$(resolve_image_entry /app/services/bayn/dist/restate-research-server.js)"
execution_server="$(resolve_image_entry /app/services/bayn/dist/restate-execution-server.js)"
image_node="$(resolve_image_entry /bin/node)"
streaming_diagnostics="$(resolve_image_entry /app/services/bayn/dist/streaming-diagnostics-command.js)"

test -x "${forward_wrapper}"
test -f "${forward_command}"
test -x "${cost_wrapper}"
test -f "${cost_command}"
test -x "${research_wrapper}"
test -f "${research_command}"
test -x "${gepa_wrapper}"
test -f "${gepa_runner}"
test -x "${gepa_native_wrapper}"
test -f "${gepa_native_runner}"
test -x "${evaluation_wrapper}"
test -f "${evaluation_command}"
test -x "${backtest_wrapper}"
test -f "${backtest_command}"
test -f "${research_server}"
test -f "${execution_server}"
test -x "${image_node}"
test -f "${streaming_diagnostics}"

printf 'Bayn image command files verified in archive.\n'
