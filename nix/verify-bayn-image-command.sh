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
replay_wrapper="$(resolve_image_entry /bin/bayn-backtest)"
replay_command="$(resolve_image_entry /app/services/bayn/dist/backtest-command.js)"
control_wrapper="$(resolve_image_entry /bin/bayn-control-study)"
control_command="$(resolve_image_entry /app/services/bayn/dist/control-study-command.js)"
study_export_wrapper="$(resolve_image_entry /bin/bayn-jev-study-export)"
study_export_command="$(resolve_image_entry /app/services/bayn/dist/jev-study-export-command.js)"
execution_server="$(resolve_image_entry /app/services/bayn/dist/restate-execution-server.js)"
image_node="$(resolve_image_entry /bin/node)"
streaming_diagnostics="$(resolve_image_entry /app/services/bayn/dist/streaming-diagnostics-command.js)"

test -x "${forward_wrapper}"
test -f "${forward_command}"
test -x "${cost_wrapper}"
test -f "${cost_command}"
test -x "${replay_wrapper}"
test -f "${replay_command}"
test -x "${control_wrapper}"
test -f "${control_command}"
test -x "${study_export_wrapper}"
test -f "${study_export_command}"
test -f "${execution_server}"
test -x "${image_node}"
test -f "${streaming_diagnostics}"

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
expected='Usage: bayn-forward-performance [--authority-generation <sha256> [--persist-receipt]] | --help'
if [[ "${actual}" != "${expected}" ]]; then
  printf 'Unexpected Bayn forward-performance help output:\n%s\n' "${actual}" >&2
  exit 1
fi

cost_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/bayn-inference-cost "${image_id}" --help)"
expected_cost='Usage: bayn-inference-cost (--session YYYY-MM-DD | --evidence evidence.json) --rate-card rates.json [--expenses packet.json] | --ledger-session YYYY-MM-DD | --help'
if [[ "${cost_actual}" != "${expected_cost}" ]]; then
  printf 'Unexpected Bayn inference-cost help output: %s\n' "${cost_actual}" >&2
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
    --entrypoint /bin/bayn-backtest \
    "${image_id}" \
    --help
)"
expected_replay='Usage: bayn-backtest --input <backtest.json> --arrivals <source.ndjson.gz> --source-receipt <receipt.json> --source-receipt-sha256 <trusted-hash> --output <new-directory> | --help'
if [[ "${replay_actual}" != "${expected_replay}" ]]; then
  printf 'Unexpected Bayn backtest help output:\n%s\n' "${replay_actual}" >&2
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
    /app/services/bayn/dist/backtest-command.js \
    --help
)"
if [[ "${compiled_replay_actual}" != "${expected_replay}" ]]; then
  printf 'Unexpected compiled Bayn backtest help output:\n%s\n' "${compiled_replay_actual}" >&2
  exit 1
fi

expected_control='Usage: bayn-control-study --input <json> --input-sha256 <sha256> --arrivals <ndjson.gz> --source-receipt <json> --source-receipt-sha256 <sha256> --output <new-json> [--mode study|preflight] [--evidence-directory <new-directory-required-for-JEV-study>] | --help'
control_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/bayn-control-study "${image_id}" --help)"
if [[ "${control_actual}" != "${expected_control}" ]]; then
  printf 'Unexpected Bayn control-study help output: %s\n' "${control_actual}" >&2
  exit 1
fi
compiled_control_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/node "${image_id}" \
  /app/services/bayn/dist/control-study-command.js --help)"
if [[ "${compiled_control_actual}" != "${expected_control}" ]]; then
  printf 'Unexpected compiled Bayn control-study help output: %s\n' "${compiled_control_actual}" >&2
  exit 1
fi

expected_study_export='Usage: bayn-jev-study-export --session YYYY-MM-DD --output <new-private-directory> | --help'
study_export_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/bayn-jev-study-export "${image_id}" --help)"
if [[ "${study_export_actual}" != "${expected_study_export}" ]]; then
  printf 'Unexpected Bayn Jev study-export help output: %s\n' "${study_export_actual}" >&2
  exit 1
fi
compiled_study_export_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/node "${image_id}" \
  /app/services/bayn/dist/jev-study-export-command.js --help)"
if [[ "${compiled_study_export_actual}" != "${expected_study_export}" ]]; then
  printf 'Unexpected compiled Bayn Jev study-export help output: %s\n' "${compiled_study_export_actual}" >&2
  exit 1
fi

# Loading diagnostics also loads the external Kafka client and its codec dependencies.
expected_streaming='Usage: bayn-streaming-diagnostics --since <UTC-instant> [--bootstrap-timeout-seconds <1..14400>] | --codecs | --help'
streaming_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/node "${image_id}" \
  /app/services/bayn/dist/streaming-diagnostics-command.js --help)"
if [[ "${streaming_actual}" != "${expected_streaming}" ]]; then
  printf 'Unexpected Bayn diagnostics help output: %s\n' "${streaming_actual}" >&2
  exit 1
fi

codecs_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --env NODE_ENV=production --entrypoint /bin/node "${image_id}" \
  /app/services/bayn/dist/streaming-diagnostics-command.js --codecs)"
if [[ "${codecs_actual}" != 'Kafka codecs verified: gzip,snappy,lz4,zstd' ]]; then
  printf 'Unexpected Kafka codec verification output: %s\n' "${codecs_actual}" >&2
  exit 1
fi

printf '%s\n' "${actual}"
