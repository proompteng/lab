#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
(cd ../nanoagent && GOWORK=off go test -c -o "$fixture_dir/nanoagent-rpc-fixture")
NANOAGENT_RPC_FIXTURE="$fixture_dir/nanoagent-rpc-fixture" \
  cargo test --locked rust_client_uses_real_go_guest_for_files_codex_and_terminal_streams -- --ignored
