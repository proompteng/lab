#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
fixture_mode="${1:-control}"
case "$fixture_mode" in control|identity) ;; *) printf 'Expected control or identity fixture\n' >&2; exit 2 ;; esac
fixture_dir="$(mktemp -d)"
fixture_name="ofz-control-$(basename "$fixture_dir" | tr '[:upper:]' '[:lower:]')"
fixture_database="$fixture_name-db"
fixture_network="$fixture_name-net"
fixture_tunnel_pid=''
docker_args=()
if [[ -n "${OFZ_FIXTURE_SSH:-}" ]]; then
  docker_args=(--host "ssh://$OFZ_FIXTURE_SSH")
fi
fixture_docker() { docker "${docker_args[@]}" "$@"; }
cleanup() {
  if [[ -n "$fixture_tunnel_pid" ]]; then kill "$fixture_tunnel_pid" 2>/dev/null || true; fi
  fixture_docker rm -f "$fixture_name" "$fixture_database" >/dev/null 2>&1 || true
  fixture_docker network rm "$fixture_network" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Ofz disposable fixture CA' \
  -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > "$fixture_dir/server.ext"
openssl x509 -req -in "$fixture_dir/server.csr" -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" \
  -CAcreateserial -days 1 -sha256 -extfile "$fixture_dir/server.ext" -out "$fixture_dir/server.crt" >/dev/null 2>&1
printf 'ofz-policy-fixture' > "$fixture_dir/native.key"
fixture_docker network create "$fixture_network" >/dev/null
postgres_image=ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1
spicedb_image=ghcr.io/authzed/spicedb@sha256:aa96009a0477f8a759149823407d47ad16d1a74390bae3102b3b0b7143502764
# shellcheck disable=SC2016
fixture_docker run --detach --name "$fixture_database" --network "$fixture_network" --publish 127.0.0.1::5432 \
  --tmpfs /tmp:rw,size=268435456,mode=1777 --memory 512m --entrypoint bash "$postgres_image" -ec \
  'for attempt in $(seq 1 300); do if test -f /tmp/fixture-ready; then break; fi; sleep 0.1; done; test -f /tmp/fixture-ready; initdb -D /tmp/ofz-data --auth=trust -U postgres >/dev/null; printf "local all all trust\nhostnossl all all 0.0.0.0/0 reject\nhostssl all postgres 0.0.0.0/0 trust\nhostssl all all 0.0.0.0/0 scram-sha-256\n" > /tmp/ofz-data/pg_hba.conf; exec postgres -D /tmp/ofz-data -c track_commit_timestamp=on -c listen_addresses="*" -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key' >/dev/null
fixture_docker exec --user 0 -i "$fixture_database" sh -ec 'cat > /tmp/server.crt' < "$fixture_dir/server.crt"
fixture_docker exec --user 0 -i "$fixture_database" sh -ec 'cat > /tmp/server.key' < "$fixture_dir/server.key"
fixture_docker exec --user 0 "$fixture_database" sh -ec 'chown postgres:postgres /tmp/server.key /tmp/server.crt; chmod 600 /tmp/server.key; touch /tmp/fixture-ready'
for attempt in $(seq 1 60); do
  if fixture_docker exec "$fixture_database" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then fixture_docker logs "$fixture_database"; exit 1; fi
  sleep 1
done
fixture_docker exec "$fixture_database" createdb -U postgres ofz_control
fixture_uri="postgres://postgres@$fixture_database:5432/postgres?sslmode=require"
fixture_docker run --rm --network "$fixture_network" "$spicedb_image" datastore migrate head \
  --datastore-engine=postgres --datastore-conn-uri="$fixture_uri" --skip-release-check=true --log-level=warn >/dev/null
fixture_docker run --detach --name "$fixture_name" --network "$fixture_network" --memory 768m --publish 127.0.0.1::8443 \
  "$spicedb_image" serve --datastore-engine=postgres --datastore-conn-uri="$fixture_uri" \
  --grpc-preshared-key=ofz-policy-fixture --dispatch-cache-enabled=false --dispatch-cluster-cache-enabled=false \
  --http-enabled=true --telemetry-endpoint='' --skip-release-check=true --log-level=warn >/dev/null
fixture_port="$(fixture_docker port "$fixture_name" 8443/tcp | sed 's/.*://')"
fixture_pg_port="$(fixture_docker port "$fixture_database" 5432/tcp | sed 's/.*://')"
if [[ -n "${OFZ_FIXTURE_SSH:-}" ]]; then
  read -r local_pg local_native < <(python3 - <<'PY'
import socket
with socket.socket() as a, socket.socket() as b:
    a.bind(('127.0.0.1', 0)); b.bind(('127.0.0.1', 0))
    print(a.getsockname()[1], b.getsockname()[1])
PY
  )
  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -L "127.0.0.1:$local_pg:127.0.0.1:$fixture_pg_port" \
    -L "127.0.0.1:$local_native:127.0.0.1:$fixture_port" "$OFZ_FIXTURE_SSH" &
  fixture_tunnel_pid=$!
  fixture_pg_port="$local_pg"
  fixture_port="$local_native"
fi
export OFZ_TEST_DSN="host=localhost port=$fixture_pg_port dbname=ofz_control user=postgres sslmode=require"
export OFZ_TEST_CA_FILE="$fixture_dir/ca.crt"
export OFZ_TEST_NATIVE_KEY_FILE="$fixture_dir/native.key"
export OFZ_TEST_NATIVE_ENDPOINT="http://127.0.0.1:$fixture_port"
for attempt in $(seq 1 60); do
  if curl --silent --fail --max-time 1 "$OFZ_TEST_NATIVE_ENDPOINT/healthz" >/dev/null; then
    if [[ "$fixture_mode" == control ]]; then
      cargo test --locked --lib control_integration -- --ignored --nocapture
    else
      : "${KEYCLOAK_FIXTURE_BIN:?Set KEYCLOAK_FIXTURE_BIN to the verified Keycloak 26.7.3 distribution}"
      cargo build --locked
      cd ../../apps/landing
      OFZ_IDENTITY_FIXTURE=1 bun test src/lib/tengri/identity.e2e.test.ts
    fi
    exit 0
  fi
  if [[ "$attempt" == 60 ]]; then fixture_docker logs "$fixture_name"; exit 1; fi
  sleep 1
done
