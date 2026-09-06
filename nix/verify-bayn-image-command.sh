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
replay_wrapper="$(resolve_image_entry /bin/bayn-intraday-replay)"
replay_command="$(resolve_image_entry /app/services/bayn/dist/intraday-replay-command.js)"
vendor_wrapper="$(resolve_image_entry /bin/bayn-vendor-intraday-replay)"
vendor_command="$(resolve_image_entry /app/services/bayn/dist/vendor-intraday-replay-command.js)"
execution_server="$(resolve_image_entry /app/services/bayn/dist/restate-execution-server.js)"
image_node="$(resolve_image_entry /bin/node)"

test -x "${forward_wrapper}"
test -f "${forward_command}"
test -x "${replay_wrapper}"
test -f "${replay_command}"
test -x "${vendor_wrapper}"
test -f "${vendor_command}"
test -f "${execution_server}"
test -x "${image_node}"

image_ref="$(jq -er '.[0].RepoTags | if length == 1 then .[0] else error("expected one image tag") end' \
  "${archive}/manifest.json")"
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  echo 'Bayn image command verification requires an isolated Docker daemon.' >&2
  exit 1
fi
docker load --input "${image_tar}" >/dev/null
image_id="$(docker image inspect --format '{{.Id}}' "${image_ref}")"
actual="$(
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --env NODE_ENV=production \
    --entrypoint /bin/bayn-forward-performance \
    "${image_id}" \
    --help
)"
expected='Usage: bayn-forward-performance [--authority-generation <sha256>] | --help'
if [[ "${actual}" != "${expected}" ]]; then
  printf 'Unexpected Bayn forward-performance help output:\n%s\n' "${actual}" >&2
  exit 1
fi

replay_actual="$(
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --env NODE_ENV=production \
    --entrypoint /bin/bayn-intraday-replay \
    "${image_id}" \
    --help
)"
expected_replay='Usage: bayn-intraday-replay --input <path> | --help'
if [[ "${replay_actual}" != "${expected_replay}" ]]; then
  printf 'Unexpected Bayn intraday-replay help output:\n%s\n' "${replay_actual}" >&2
  exit 1
fi

compiled_replay_actual="$(
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --env NODE_ENV=production \
    --entrypoint /bin/node \
    "${image_id}" \
    /app/services/bayn/dist/intraday-replay-command.js \
    --help
)"
if [[ "${compiled_replay_actual}" != "${expected_replay}" ]]; then
  printf 'Unexpected compiled Bayn intraday-replay help output:\n%s\n' "${compiled_replay_actual}" >&2
  exit 1
fi

vendor_actual="$(
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --env NODE_ENV=production \
    --entrypoint /bin/bayn-vendor-intraday-replay \
    "${image_id}" \
    --help
)"
expected_vendor='Usage: bayn-vendor-intraday-replay --input <path> --cache <directory> | --help'
if [[ "${vendor_actual}" != "${expected_vendor}" ]]; then
  printf 'Unexpected Bayn vendor-intraday-replay help output:\n%s\n' "${vendor_actual}" >&2
  exit 1
fi

compiled_vendor_actual="$(
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --env NODE_ENV=production \
    --entrypoint /bin/node \
    "${image_id}" \
    /app/services/bayn/dist/vendor-intraday-replay-command.js \
    --help
)"
if [[ "${compiled_vendor_actual}" != "${expected_vendor}" ]]; then
  printf 'Unexpected compiled Bayn vendor-intraday-replay help output:\n%s\n' "${compiled_vendor_actual}" >&2
  exit 1
fi

printf '%s\n' "${actual}"
