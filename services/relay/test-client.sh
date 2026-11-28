#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
cargo build --manifest-path services/relay/Cargo.toml --locked --bin relay-client
cargo build --manifest-path services/relay/Cargo.toml --locked --example federation-fixture
cargo build --manifest-path services/relay/Cargo.toml --locked --bin relay-federation-probe
RELAY_FEDERATION_FIXTURE_BIN="$PWD/services/relay/target/debug/examples/federation-fixture" \
  RELAY_FEDERATION_PROBE_BIN="$PWD/services/relay/target/debug/relay-federation-probe" \
  bun test --cwd apps/landing src/lib/platform/federation.e2e.test.ts
RELAY_CLIENT_FIXTURE_BIN="$PWD/services/relay/target/debug/relay-client" \
  bun test --cwd apps/landing src/lib/platform/relay-client.e2e.test.ts src/lib/platform/relay-proxy.e2e.test.ts
bun test --cwd apps/landing src/lib/tengri/connection-lifecycle.e2e.test.ts
bun test --cwd apps/landing src/lib/platform/provider-routes.e2e.test.ts
