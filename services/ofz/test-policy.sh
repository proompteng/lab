#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
fixture_dir="$(mktemp -d)"
fixture_container="ofz-policy-$(basename "$fixture_dir" | tr '[:upper:]' '[:lower:]')"
fixture_database="$fixture_container-db"
fixture_network="$fixture_container-net"
spicedb_image=ghcr.io/authzed/spicedb@sha256:aa96009a0477f8a759149823407d47ad16d1a74390bae3102b3b0b7143502764
postgres_image=ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1
cleanup() {
  docker rm -f "$fixture_container" "$fixture_database" >/dev/null 2>&1 || true
  docker network rm "$fixture_network" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
docker network create "$fixture_network" >/dev/null
docker run --detach --name "$fixture_database" --network "$fixture_network" \
  --tmpfs /tmp:rw,size=268435456,mode=1777 --memory 512m \
  --entrypoint bash "$postgres_image" -ec \
  'initdb -D /tmp/ofz-data --auth=trust -U postgres >/dev/null; printf "host all all 0.0.0.0/0 trust\n" >> /tmp/ofz-data/pg_hba.conf; exec postgres -D /tmp/ofz-data -c track_commit_timestamp=on -c listen_addresses="*"' >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$fixture_database" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    docker logs "$fixture_database"
    exit 1
  fi
  sleep 1
done
fixture_uri="postgres://postgres@$fixture_database:5432/postgres?sslmode=disable"
docker run --rm --network "$fixture_network" "$spicedb_image" \
  datastore migrate head --skip-release-check=true --log-level=warn \
  --datastore-engine=postgres --datastore-conn-uri="$fixture_uri" >/dev/null
docker run --detach --name "$fixture_container" \
  --network "$fixture_network" --memory 768m \
  --publish 127.0.0.1::8443 \
  "$spicedb_image" \
  serve --datastore-engine=postgres --datastore-conn-uri="$fixture_uri" \
  --grpc-preshared-key=ofz-policy-fixture \
  --dispatch-cache-enabled=false --dispatch-cluster-cache-enabled=false \
  --http-enabled=true --telemetry-endpoint='' --skip-release-check=true --log-level=warn >/dev/null
fixture_port="$(docker port "$fixture_container" 8443/tcp | sed 's/.*://')" || {
  docker logs "$fixture_container"
  exit 1
}
fixture_endpoint="http://127.0.0.1:$fixture_port"
for attempt in $(seq 1 60); do
  if curl --silent --fail --max-time 1 "$fixture_endpoint/healthz" >/dev/null; then
    python3 tests/policy.py "$fixture_endpoint"
    exit 0
  fi
  if [[ "$attempt" == 60 ]]; then
    docker logs "$fixture_container"
    exit 1
  fi
  sleep 1
done
