#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 || ( "$2" != trading && "$2" != research ) ]]; then
  echo "Usage: verify-bayn-image-command <nix-image-tar> <trading|research>" >&2
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

role="$2"
image_node="$(resolve_image_entry /bin/node)"
test -x "${image_node}"

if [[ "${role}" = trading ]]; then
  for command in index restate-execution-server restate-execution-activate market-projection-worker decision-construction-worker \
    forward-performance-command control-opening-command inference-cost-command streaming-diagnostics-command glitchtip-smoke-command valkey-command backtest-command; do
    test -f "$(resolve_image_entry "/app/services/bayn/dist/${command}.js")"
  done
  test -x "$(resolve_image_entry /bin/bayn-inference-cost)"
  test -x "$(resolve_image_entry /bin/bayn-forward-performance)"
  test -x "$(resolve_image_entry /bin/bayn-control-opening)"
  test -f "$(resolve_image_entry /app/services/bayn/dist/jev-compiler-dependencies.json)"
  for command in python python3 git bun crane bayn-research bayn-gepa bayn-backtest bayn-system-assessment bayn-jev-study-export; do
    if [[ -e "${rootfs}/bin/${command}" || -L "${rootfs}/bin/${command}" ]]; then
      echo "Trading image contains research executable ${command}." >&2
      exit 1
    fi
  done
  for command in restate-research-server research-command control-study-command system-assessment-command jev-study-export-command; do
    if [[ -e "${rootfs}/app/services/bayn/dist/${command}.js" ]]; then
      echo "Trading image contains research bundle ${command}." >&2
      exit 1
    fi
  done
  if [[ -d "${rootfs}/app/services/bayn/gepa" ]]; then
    echo 'Trading image contains GEPA sources.' >&2
    exit 1
  fi

  # Inspect the bundled client, not just its dependency manifest: the fixed-output
  # dependency closure must preserve cancellation of stalled Redis connections.
  for command in index restate-execution-server valkey-command; do
    bundle="$(resolve_image_entry "/app/services/bayn/dist/${command}.js")"
    if ! grep -Fq 'this.#connectController?.abort()' "${bundle}" ||
      ! grep -Fq 'this.#connectWithSignal(retries, controller.signal)' "${bundle}" ||
      ! grep -Fq 'AbortSignal.any([withDefaults.signal, signal])' "${bundle}"; then
      echo "Bayn image bundle is missing native Redis connection cancellation: ${command}" >&2
      exit 1
    fi
  done
else
  for command in system-assessment forward-performance research webull-research jev-evaluate backtest frozen-control-backtest control-study native-arrival-export jev-study-export gepa gepa-native; do
    test -x "$(resolve_image_entry "/bin/bayn-${command}")"
  done
  for command in restate-research-server system-assessment-command forward-performance-command research-command \
    webull-research-command jev-evaluation-command backtest-command frozen-control-command control-study-command native-arrival-export-command jev-study-export-command; do
    test -f "$(resolve_image_entry "/app/services/bayn/dist/${command}.js")"
  done
  for receipt in jev-compiler-dependencies frozen-control-compiler; do
    test -f "$(resolve_image_entry "/app/services/bayn/dist/${receipt}.json")"
  done
  for runner in runner native; do
    test -f "$(resolve_image_entry "/app/services/bayn/gepa/${runner}.py")"
  done
  for command in git bun crane; do
    test -x "$(resolve_image_entry "/bin/${command}")"
  done
  for command in restate-execution-server control-opening-command; do
    if [[ -e "${rootfs}/app/services/bayn/dist/${command}.js" ]]; then
      echo "Research image contains trading bundle ${command}." >&2
      exit 1
    fi
  done
  if [[ -e "${rootfs}/bin/bayn-control-opening" || -L "${rootfs}/bin/bayn-control-opening" ]]; then
    echo 'Research image contains the trading opening-capture executable.' >&2
    exit 1
  fi
fi
printf 'Bayn %s image commands and role separation verified in archive.\n' "${role}"
