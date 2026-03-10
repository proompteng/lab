#!/usr/bin/env bash

set -euo pipefail

service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$service_dir/../.." && pwd)"
output_dir="$service_dir/output/playwright"
jangar_log="$output_dir/openwebui-e2e.jangar.log"
codex_auth_json="${CODEX_AUTH_JSON:-$HOME/.codex/auth.json}"
codex_config_fixture="$service_dir/tests/fixtures/codex-e2e.config.toml"
temp_codex_home=''
temp_codex_repo=''
use_mock_codex="${OPENWEBUI_E2E_USE_MOCK_CODEX:-1}"

mkdir -p "$output_dir"
: >"$jangar_log"
rm -f "$output_dir/openwebui-e2e.codex-stub.jsonl"

if [[ "$use_mock_codex" != "1" ]]; then
  if [[ ! -f "$codex_auth_json" ]]; then
    echo "Codex auth file not found at $codex_auth_json" >&2
    exit 1
  fi

  if [[ -n "${OPENWEBUI_E2E_CODEX_HOME:-}" ]]; then
    codex_home="$OPENWEBUI_E2E_CODEX_HOME"
  else
    temp_codex_home="$(mktemp -d "${TMPDIR:-/tmp}/jangar-openwebui-codex-home.XXXXXX")"
    codex_home="$temp_codex_home"
  fi

  rm -rf "$codex_home"
  mkdir -p "$codex_home"
  cp "$codex_auth_json" "$codex_home/auth.json"
  cp "$codex_config_fixture" "$codex_home/config.toml"
  export CODEX_HOME="$codex_home"
fi

pick_free_port() {
  python - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
}

prepare_mock_repo_root() {
  temp_codex_repo="$(mktemp -d "${TMPDIR:-/tmp}/jangar-openwebui-repo.XXXXXX")"
  git clone --shared --quiet "$repo_root" "$temp_codex_repo"
}

export PLAYWRIGHT_OPENWEBUI_E2E=1
export PLAYWRIGHT_SKIP_WEBSERVER=1
export OPENWEBUI_E2E_USE_MOCK_CODEX="$use_mock_codex"
export JANGAR_PORT="${JANGAR_PORT:-$(pick_free_port)}"
export PORT="$JANGAR_PORT"
export HOST="${HOST:-0.0.0.0}"
export OPENWEBUI_PORT="${OPENWEBUI_PORT:-$(pick_free_port)}"
export OPENWEBUI_IMAGE="${OPENWEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.8.9}"
if [[ "$use_mock_codex" == "1" ]]; then
  export JANGAR_MOCK_CODEX=1
  if [[ -n "${CODEX_CWD:-}" ]]; then
    export CODEX_CWD
  else
    prepare_mock_repo_root
    export CODEX_CWD="$temp_codex_repo"
  fi
else
  export JANGAR_CODEX_BINARY="${JANGAR_CODEX_BINARY:-$(command -v codex)}"
  export CODEX_CWD="${CODEX_CWD:-$repo_root}"
fi
export JANGAR_MODELS="${JANGAR_MODELS:-gpt-5.4}"
export JANGAR_DEFAULT_MODEL="${JANGAR_DEFAULT_MODEL:-gpt-5.4}"
export OPENWEBUI_DEFAULT_MODEL="${OPENWEBUI_DEFAULT_MODEL:-$JANGAR_DEFAULT_MODEL}"
export OPENWEBUI_E2E_MODEL="${OPENWEBUI_E2E_MODEL:-$OPENWEBUI_DEFAULT_MODEL}"
export JANGAR_CHAT_STATE_BACKEND="${JANGAR_CHAT_STATE_BACKEND:-memory}"
export JANGAR_OPENWEBUI_RICH_RENDER_ENABLED="${JANGAR_OPENWEBUI_RICH_RENDER_ENABLED:-1}"
export JANGAR_OPENWEBUI_EXTERNAL_BASE_URL="${JANGAR_OPENWEBUI_EXTERNAL_BASE_URL:-http://jangar.localhost:${JANGAR_PORT}}"
export JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET="${JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET:-openwebui-e2e-test-secret}"
export JANGAR_BUN_SHIM=1
export JANGAR_AGENTS_CONTROLLER_ENABLED=0
export JANGAR_ORCHESTRATION_CONTROLLER_ENABLED=0
export JANGAR_SUPPORTING_CONTROLLER_ENABLED=0
export JANGAR_PRIMITIVES_RECONCILER=0
export JANGAR_LEADER_ELECTION_ENABLED=0
export JANGAR_SKIP_MIGRATIONS=1
export PGSSLMODE="${PGSSLMODE:-disable}"
export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/jangar}"

terminate_pid() {
  local pid="$1"

  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    wait "$pid" >/dev/null 2>&1 || true
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "${jangar_pid:-}" ]] && kill -0 "$jangar_pid" >/dev/null 2>&1; then
    pkill -P "$jangar_pid" >/dev/null 2>&1 || true
    terminate_pid "$jangar_pid"
  fi

  if command -v lsof >/dev/null 2>&1; then
    local jangar_port_pids
    jangar_port_pids="$(lsof -ti "tcp:${JANGAR_PORT}" 2>/dev/null || true)"
    if [[ -n "$jangar_port_pids" ]]; then
      while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue
        terminate_pid "$pid"
      done <<< "$jangar_port_pids"
    fi
  fi

  if [[ -n "$temp_codex_home" ]]; then
    rm -rf "$temp_codex_home"
  fi

  if [[ -n "$temp_codex_repo" ]]; then
    rm -rf "$temp_codex_repo"
  fi
}

trap cleanup EXIT

cd "$service_dir"
(
  cd "$service_dir"
  if [[ "${OPENWEBUI_E2E_SKIP_BUILD:-0}" != "1" ]]; then
    bun run build
  fi
  exec bun .output/server/index.mjs
) >"$jangar_log" 2>&1 &
jangar_pid=$!
export JANGAR_PID="$jangar_pid"
export JANGAR_LOG_PATH="$jangar_log"

python - <<'PY'
import os
import pathlib
import time
import urllib.request

port = os.environ['JANGAR_PORT']
url = f'http://127.0.0.1:{port}/openai/v1/models'
log_path = pathlib.Path(os.environ['JANGAR_LOG_PATH'])
pid = int(os.environ['JANGAR_PID'])

for _ in range(240):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            if response.status == 200:
                raise SystemExit(0)
    except Exception:
        pass

    try:
        os.kill(pid, 0)
    except OSError:
        if log_path.exists():
            print(log_path.read_text())
        raise SystemExit(f'Jangar exited before becoming ready on {url}')

    time.sleep(1)

if log_path.exists():
    print(log_path.read_text())
raise SystemExit(f'Timed out waiting for {url}')
PY

bunx playwright test --config playwright.config.ts tests/openwebui-chat.e2e.ts
