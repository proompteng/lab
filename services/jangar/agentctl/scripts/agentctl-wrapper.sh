#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AGENTCTL_VERSION:-}" ]]; then
  export AGENTCTL_VERSION="__AGENTCTL_VERSION__"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBEXEC_DIR="${AGENTCTL_LIBEXEC:-${SCRIPT_DIR}/../libexec}"

resolve_bun() {
  if [[ -x "${SCRIPT_DIR}/agentctl-bun" ]]; then
    echo "${SCRIPT_DIR}/agentctl-bun"
    return 0
  fi
  if [[ -x "${LIBEXEC_DIR}/agentctl-bun" ]]; then
    echo "${LIBEXEC_DIR}/agentctl-bun"
    return 0
  fi
  return 1
}

resolve_node_script() {
  if [[ -f "${SCRIPT_DIR}/agentctl.js" ]]; then
    echo "${SCRIPT_DIR}/agentctl.js"
    return 0
  fi
  if [[ -f "${LIBEXEC_DIR}/agentctl.js" ]]; then
    echo "${LIBEXEC_DIR}/agentctl.js"
    return 0
  fi
  return 1
}

run_bun() {
  local bun_bin
  if ! bun_bin="$(resolve_bun)"; then
    echo "agentctl: bun binary not found" >&2
    exit 1
  fi
  exec "${bun_bin}" "$@"
}

run_node() {
  local node_script
  if ! node_script="$(resolve_node_script)"; then
    echo "agentctl: node script not found" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "agentctl: node is required for kube mode; install node or set AGENTCTL_RUNTIME=bun" >&2
    exit 1
  fi
  exec node "${node_script}" "$@"
}

if [[ "${AGENTCTL_RUNTIME:-}" == "bun" ]]; then
  run_bun "$@"
fi

if [[ "${AGENTCTL_RUNTIME:-}" == "node" ]]; then
  run_node "$@"
fi

if [[ "${AGENTCTL_MODE:-}" == "grpc" ]]; then
  run_bun "$@"
fi

if [[ "${AGENTCTL_MODE:-}" == "kube" ]]; then
  run_node "$@"
fi

for arg in "$@"; do
  case "${arg}" in
    --grpc)
      run_bun "$@"
      ;;
    --kube)
      run_node "$@"
      ;;
    --address*|--server*)
      run_bun "$@"
      ;;
  esac
done

if [[ -n "${AGENTCTL_ADDRESS:-}" || -n "${AGENTCTL_SERVER:-}" || -n "${JANGAR_GRPC_ADDRESS:-}" ]]; then
  run_bun "$@"
fi

run_node "$@"
