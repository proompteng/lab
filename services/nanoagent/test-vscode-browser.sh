#!/usr/bin/env bash
set -euo pipefail

repository="$(cd "$(dirname "$0")/../.." && pwd)"
fixture_root="$(mktemp -d "/tmp/tengri-vscode.XXXXXX")"
fixture_pids=""
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  curl --max-time 3 -fsS -X POST http://127.0.0.1:8080/_test/shutdown >/dev/null 2>&1 || true
  curl --max-time 3 -fsS -X POST http://localhost:33082/_test/shutdown >/dev/null 2>&1 || true
  for ((attempt = 0; attempt < 50; attempt++)); do
    if [[ -z "${fixture_guest_pid:-}" ]] || ! kill -0 "$fixture_guest_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  for fixture_pid in $fixture_pids; do kill "$fixture_pid" 2>/dev/null || true; done
  for fixture_pid in $fixture_pids; do wait "$fixture_pid" 2>/dev/null || true; done
  printf 'VS Code acceptance logs: %s\n' "$fixture_root"
  if [[ "$result" != 0 ]]; then tail -n 60 "$fixture_root"/*.log 2>/dev/null || true; fi
  exit "$result"
}
# Refuse to attach to an unrelated process or send it a shutdown request.
python3 - <<'PY'
import socket
for port in (8080, 13338, 3143, 33082, 33083, 3443):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', port))
PY
trap cleanup EXIT INT TERM
mkdir -p "$fixture_root/home/workspace"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=DNS:*.tengri.localhost' -keyout "$fixture_root/tls.key" -out "$fixture_root/tls.crt" >"$fixture_root/tls.log" 2>&1
# Chromium service workers need the fixture's certificate trusted at browser launch.
TENGRI_EDITOR_TEST_CERT_SPKI="$(openssl x509 -in "$fixture_root/tls.crt" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)"
export TENGRI_EDITOR_TEST_CERT_SPKI
node "$repository/services/nanoagent/vscode-test-proxy.mjs" "$fixture_root/tls.crt" "$fixture_root/tls.key" >"$fixture_root/proxy.log" 2>&1 &
fixture_pids="$fixture_pids $!"
fixture_install_home="${TENGRI_EDITOR_INSTALL_HOME:-$repository/node_modules/.cache/tengri-code-server}"
env HOME="$fixture_install_home" bash "$repository/services/nanoagent/bootstrap-code-server.sh" --install-only
export TENGRI_EDITOR_TEST_BINARY="$fixture_install_home/.local/bin/code-server"
export TENGRI_EDITOR_TEST_HOME="$fixture_root/home"
export TENGRI_EDITOR_BROWSER_FIXTURE=1
export TENGRI_EDITOR_TEST_HTTPS=1
export TENGRI_PLAYWRIGHT_BASE_URL=https://desktop.tengri.localhost:3443
export TENGRI_PLAYWRIGHT_SKIP_WEBSERVER=1
(
  cd "$repository/services/nanoagent"
  GOWORK=off go test -c -o "$fixture_root/nanoagent.test"
)
SHELL=/bin/bash "$fixture_root/nanoagent.test" -test.run '^TestEditorBrowserFixture$' -test.timeout 0 -test.v >"$fixture_root/guest.log" 2>&1 &
fixture_guest_pid=$!
fixture_pids="$fixture_pids $fixture_guest_pid"
(
  cd "$repository"
  cargo test --locked --manifest-path services/tengri/Cargo.toml editor_browser_acceptance_fixture -- --ignored --nocapture
) >"$fixture_root/gateway.log" 2>&1 &
fixture_pids="$fixture_pids $!"
(
  cd "$repository/apps/landing"
  export NEXT_TELEMETRY_DISABLED=1
  export TENGRI_PUBLIC_URL=https://gateway.tengri.localhost:3443
  export TENGRI_PREVIEW_FRAME_SOURCE='https://*.tengri.localhost:3443'
  export BETTER_AUTH_SECRET=playwright-better-auth-secret-000000000000
  export BETTER_AUTH_URL="$TENGRI_PLAYWRIGHT_BASE_URL"
  export GITHUB_CLIENT_ID=playwright GITHUB_CLIENT_SECRET=playwright
  export TENGRI_GRPC_ENDPOINT=127.0.0.1:65535
  export TENGRI_INTERNAL_HMAC_SECRET=playwright-tengri-hmac-secret-0000000000
  if [[ "${TENGRI_EDITOR_NEXT_MODE:-dev}" == start ]]; then
    mkdir -p "$fixture_root/desktop/apps/landing/.next" "$fixture_root/desktop/services/tengri"
    cp -R .next/standalone/. "$fixture_root/desktop/"
    cp -R .next/static "$fixture_root/desktop/apps/landing/.next/static"
    cp -R public "$fixture_root/desktop/apps/landing/public"
    cp -R "$repository/services/tengri/proto" "$fixture_root/desktop/services/tengri/proto"
    cd "$fixture_root/desktop/apps/landing"
    PORT=3143 HOSTNAME=127.0.0.1 exec node server.js
  else
    exec bunx next dev --hostname 127.0.0.1 --port 3143
  fi
) >"$fixture_root/desktop.log" 2>&1 &
fixture_pids="$fixture_pids $!"
python3 - <<'PY'
import socket, time
for port in (8080, 33082, 33083, 3143, 3443):
    deadline = time.monotonic() + 300
    while True:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1): break
        except OSError:
            if time.monotonic() > deadline: raise RuntimeError(f'Fixture on port {port} failed to start')
            time.sleep(.2)
PY
cd "$repository"
bun run --cwd apps/landing test:e2e --grep @vscode
