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
evidence_wrapper="$(resolve_image_entry /bin/bayn-evidence-export)"
evidence_command="$(resolve_image_entry /app/services/bayn/dist/evidence-export-command.js)"
study_wrapper="$(resolve_image_entry /bin/bayn-jev-study-export)"
study_command="$(resolve_image_entry /app/services/bayn/dist/jev-study-export-command.js)"
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
test -x "${evidence_wrapper}"
test -f "${evidence_command}"
test -x "${study_wrapper}"
test -f "${study_command}"
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
expected='Usage: bayn-forward-performance --authority-generation <sha256> [--persist-receipt] | --help'
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

research_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-research "${image_id}" --help)"
expected_research='Usage: bayn-research --validate <run.json> | --run <run.json> --output <new-receipt.json> | --help'
if [[ "${research_actual}" != "${expected_research}" ]]; then
  printf 'Unexpected Bayn research help output: %s\n' "${research_actual}" >&2
  exit 1
fi

evidence_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-evidence-export "${image_id}" --help)"
if [[ "${evidence_actual}" != 'Usage: bayn-evidence-export '* ]]; then
  printf 'Unexpected Bayn evidence export help output: %s\n' "${evidence_actual}" >&2
  exit 1
fi

study_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-jev-study-export "${image_id}" --help)"
if [[ "${study_actual}" != 'Usage: bayn-jev-study-export '* ]]; then
  printf 'Unexpected Bayn study export help output: %s\n' "${study_actual}" >&2
  exit 1
fi

gepa_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-gepa "${image_id}" --help)"
if [[ "${gepa_actual}" != *'usage: bayn-gepa'* ]]; then
  printf 'Unexpected Bayn GEPA help output: %s\n' "${gepa_actual}" >&2
  exit 1
fi

gepa_native_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-gepa-native "${image_id}" --help)"
if [[ "${gepa_native_actual}" != *'usage: bayn-gepa-native'* ]]; then
  printf 'Unexpected Bayn GEPA native help output: %s\n' "${gepa_native_actual}" >&2
  exit 1
fi

evaluation_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-jev-evaluate "${image_id}" --help)"
if [[ "${evaluation_actual}" != 'Usage: bayn-jev-evaluate '* ]]; then
  printf 'Unexpected Bayn Jev probe help output: %s\n' "${evaluation_actual}" >&2
  exit 1
fi

backtest_actual="$(docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --cpus 1 \
  --entrypoint /bin/bayn-backtest "${image_id}" --help)"
if [[ "${backtest_actual}" != 'Usage: bayn-backtest '* ]]; then
  printf 'Unexpected Bayn native backtest help output: %s\n' "${backtest_actual}" >&2
  exit 1
fi

# Loading diagnostics also loads the external Kafka client and its codec dependencies.
expected_streaming='Usage: bayn-streaming-diagnostics --query <query.json> [--bootstrap-timeout-seconds <1..14400>] | --codecs | --help'
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
