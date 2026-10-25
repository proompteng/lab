#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
cargo build --manifest-path services/relay/Cargo.toml --locked --bin relay-client
RELAY_CLIENT_FIXTURE_BIN="$PWD/services/relay/target/debug/relay-client" \
  bun test apps/landing/src/lib/platform/relay-client.e2e.test.ts
