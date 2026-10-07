#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
fixture_dir="$(mktemp -d)"
fixture_container="tengri-authz-$(basename "$fixture_dir" | tr '[:upper:]' '[:lower:]')"
cleanup() {
  docker rm -f "$fixture_container" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
printf '%s' 'tengri-local-authorization-test' > "$fixture_dir/key"
docker run --detach --name "$fixture_container" \
  --publish 127.0.0.1::8443 \
  ghcr.io/authzed/spicedb@sha256:aa96009a0477f8a759149823407d47ad16d1a74390bae3102b3b0b7143502764 \
  serve --datastore-engine=memory --grpc-preshared-key=tengri-local-authorization-test \
  --http-enabled=true --telemetry-endpoint='' >/dev/null
fixture_port="$(docker port "$fixture_container" 8443/tcp | sed 's/.*://')"
fixture_endpoint="http://127.0.0.1:$fixture_port"
fixture_ready=false
for _ in $(seq 1 60); do
  if curl --silent --fail "$fixture_endpoint/healthz" >/dev/null; then
    fixture_ready=true
    break
  fi
  sleep 1
done
if [[ "$fixture_ready" != true ]]; then
  docker logs "$fixture_container"
  exit 1
fi
TENGRI_AUTHZ_TEST_ENDPOINT="$fixture_endpoint" \
TENGRI_AUTHZ_TEST_KEY_FILE="$fixture_dir/key" \
  cargo test --locked real_spicedb_enrollment_revocation_and_schema_preservation -- --ignored
