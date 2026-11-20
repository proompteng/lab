#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
run_id=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')
postgres_name="bayn-streaming-integration-postgres-${run_id}"
restate_name="bayn-streaming-integration-restate-${run_id}"
retirement_name="bayn-streaming-integration-retirement-restate-${run_id}"
results="$root/.artifacts/bayn-streaming-integration/$run_id"
mkdir -p "$results"

remove_owned() {
  local name=$1 identity id owner
  identity=$(docker inspect --format '{{.Id}} {{index .Config.Labels "bayn-streaming-integration-fixture"}}' "$name" 2>/dev/null) || return 0
  read -r id owner <<< "$identity"
  if [[ "$owner" == "$run_id" && "$id" =~ ^[0-9a-f]{64}$ ]]; then
    docker rm --force "$id" >/dev/null 2>&1
  fi
}
cleanup() {
  local status=$? name
  for name in "$postgres_name" "$restate_name" "$retirement_name"; do
    if [[ "$status" != 0 ]]; then
      identity=$(docker inspect --format '{{.Id}} {{index .Config.Labels "bayn-streaming-integration-fixture"}}' "$name" 2>/dev/null) || continue
      read -r id owner <<< "$identity"
      if [[ "$owner" == "$run_id" && "$id" =~ ^[0-9a-f]{64}$ ]]; then docker logs --tail 100 "$id" >&2 || true; fi
    fi
    remove_owned "$name" || true
  done
  rmdir "$results" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT

postgres_image=postgres:18-alpine
restate_image='docker.restate.dev/restatedev/restate:1.8.1@sha256:cd5ee1abb1b3f91e813e327a024779280938aaff991ccdc5b241a3a3a4bddce1'
kafka_image=confluentinc/cp-kafka:8.1.0
adapter_image='ghcr.io/restatedev/ingress-integration-kafka@sha256:20704c886ee4dcc4046bab1743dc424bb08b2317ce1bc6da55ce738345ce01b1'
for image in "$postgres_image" "$restate_image" "$kafka_image" "$adapter_image"; do
  timeout 180s docker pull "$image" >/dev/null
done

start_restate() {
  local name=$1
  docker run --detach --name "$name" --memory 2g --cpus 2 --pids-limit 512 \
    --label "bayn-streaming-integration-fixture=$run_id" \
    --tmpfs /restate-data:rw,size=512m --env RESTATE_BASE_DIR=/restate-data --env DO_NOT_TRACK=1 \
    --publish 127.0.0.1::8080 --publish 127.0.0.1::9070 \
    --add-host host.docker.internal:host-gateway "$restate_image" >/dev/null
  BAYN_TEST_RESTATE_ADMIN_URL="http://$(docker port "$name" 9070/tcp)"
  BAYN_TEST_RESTATE_INGRESS_URL="http://$(docker port "$name" 8080/tcp)"
  export BAYN_TEST_RESTATE_ADMIN_URL BAYN_TEST_RESTATE_INGRESS_URL
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if curl --max-time 2 --fail --silent "$BAYN_TEST_RESTATE_ADMIN_URL/health" >/dev/null; then return; fi
    sleep 1
  done
  echo 'Streaming Restate fixture startup timed out' >&2
  return 1
}
run_required() {
  local budget=$1 file=$2 report
  report="$results/$(basename "$file").xml"
  timeout "$budget" bun test --no-orphans --reporter=junit --reporter-outfile="$report" "$root/$file"
  python3 "$root/services/bayn/scripts/verify-integration-results.py" "$report" "$root/$file"
}

docker run --detach --name "$postgres_name" --memory 512m --cpus 1 --pids-limit 128 \
  --label "bayn-streaming-integration-fixture=$run_id" \
  --tmpfs /var/lib/postgresql:rw,size=512m \
  --env POSTGRES_USER=bayn --env POSTGRES_PASSWORD=bayn --env POSTGRES_DB=bayn_streaming_test \
  --publish 127.0.0.1::5432 "$postgres_image" >/dev/null
postgres_ready=false
for ((attempt = 1; attempt <= 60; attempt++)); do
  if docker exec "$postgres_name" pg_isready -U bayn -d bayn_streaming_test >/dev/null 2>&1; then postgres_ready=true; break; fi
  sleep 1
done
[[ "$postgres_ready" == true ]] || { echo 'Streaming PostgreSQL fixture startup timed out' >&2; exit 1; }
export BAYN_TEST_POSTGRES_URL
BAYN_TEST_POSTGRES_URL="postgresql://bayn:bayn@$(docker port "$postgres_name" 5432/tcp)/bayn_streaming_test"
start_restate "$restate_name"
run_required 120s services/bayn/src/restate/restate-entry-inference.integration.test.ts
remove_owned "$restate_name"
remove_owned "$postgres_name"
unset BAYN_TEST_POSTGRES_URL

# Retirement replaces service definitions and intentionally leaves protected work unfinished.
start_restate "$retirement_name"
export BAYN_TEST_BROKER_POLL_RESTATE_ADMIN_URL="$BAYN_TEST_RESTATE_ADMIN_URL"
export BAYN_TEST_BROKER_POLL_RESTATE_INGRESS_URL="$BAYN_TEST_RESTATE_INGRESS_URL"
run_required 60s services/bayn/tools/retire-broker-polls.integration.test.ts
remove_owned "$retirement_name"
unset BAYN_TEST_RESTATE_ADMIN_URL BAYN_TEST_RESTATE_INGRESS_URL
unset BAYN_TEST_BROKER_POLL_RESTATE_ADMIN_URL BAYN_TEST_BROKER_POLL_RESTATE_INGRESS_URL

BAYN_TEST_BROKER_KAFKA_INGRESS=true run_required 300s services/bayn/src/restate/restate-broker-kafka.integration.test.ts
