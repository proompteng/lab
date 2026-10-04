#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
mode=${1:-receipts}
[[ "$mode" == receipts || "$mode" == --capture-capacity ]] || { echo 'Unknown native fixture mode' >&2; exit 2; }
setup_deadline=$((SECONDS + 200))
setup_step() {
  if [[ "$mode" != --capture-capacity ]]; then "$@"; return; fi
  local remaining=$((setup_deadline - SECONDS))
  (( remaining > 0 )) || { echo 'Capacity fixture setup budget exhausted' >&2; return 1; }
  timeout --kill-after=2s "${remaining}s" "$@"
}
run_id=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')
export BAYN_TEST_KAFKA_USERNAME="bayn-fixture-${run_id}"
export BAYN_TEST_KAFKA_PASSWORD
BAYN_TEST_KAFKA_PASSWORD=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then printf '::add-mask::%s\n' "$BAYN_TEST_KAFKA_PASSWORD"; fi
directory=$(mktemp -d "${root}/services/bayn/.native-receipts.XXXXXX")
kafka_name="bayn-receipts-kafka-${run_id}"
restate_name="bayn-receipts-restate-${run_id}"
capacity_name="bayn-receipts-capacity-${run_id}"
kafka_id=
cleanup_names=()
cleanup() {
  status=$?
  for name in "${cleanup_names[@]}"; do
    identity=$(timeout --kill-after=1s 2s docker inspect --format '{{.Id}} {{index .Config.Labels "bayn-receipt-fixture"}}' "$name" 2>/dev/null) || {
      printf 'Fixture cleanup could not inspect %s; no removal attempted\n' "$name" >&2
      if [[ "$status" == 0 ]]; then status=1; fi
      continue
    }
    read -r id owner <<< "$identity"
    if [[ "$owner" != "$run_id" || ! "$id" =~ ^[0-9a-f]{64}$ ]]; then
      printf 'Fixture cleanup refused unowned container %s\n' "$name" >&2
      if [[ "$status" == 0 ]]; then status=1; fi
      continue
    fi
    if [[ "$status" != 0 ]]; then timeout --kill-after=1s 2s docker logs --tail 100 "$id" >&2 || true; fi
    if timeout --kill-after=1s 5s docker rm --force "$id" >/dev/null 2>&1; then
      printf 'Fixture cleanup removed %s (%s)\n' "$name" "$id"
    else
      printf 'Fixture cleanup failed or timed out for %s (%s)\n' "$name" "$id" >&2
      if [[ "$status" == 0 ]]; then status=1; fi
    fi
  done
  rm -rf "$directory"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

kafka_image='apache/kafka:4.1.1@sha256:0bc1bb2478f45b6cea78864df86acdc11e8df2c5172477819a4d12942cbe5d40'
restate_image='docker.restate.dev/restatedev/restate:1.7.9@sha256:3efeb748ebea40f0a895ca858321d0ef33396d40fe6d16ec593cd5553eb98441'
setup_step timeout 180s docker pull "$kafka_image" >/dev/null
if [[ "$mode" == receipts ]]; then timeout 180s docker pull "$restate_image" >/dev/null; fi
cleanup_names+=("$kafka_name")
# The embedded script expands the fixture credentials inside the Kafka container.
# shellcheck disable=SC2016
kafka_id=$(setup_step docker run --detach --name "$kafka_name" --memory 2g --cpus 2 --pids-limit 512 \
  --label "bayn-receipt-fixture=$run_id" \
  --publish 127.0.0.1:19092:9092 --env BAYN_TEST_KAFKA_USERNAME --env BAYN_TEST_KAFKA_PASSWORD \
  --entrypoint /bin/bash "$kafka_image" -euc '
cat > /tmp/bayn-server.properties <<EOF
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:9093
controller.listener.names=CONTROLLER
listeners=INTERNAL://0.0.0.0:9094,CONTROLLER://0.0.0.0:9093,SASL_PLAINTEXT://0.0.0.0:9092
advertised.listeners=INTERNAL://127.0.0.1:9094,SASL_PLAINTEXT://127.0.0.1:19092
listener.security.protocol.map=INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,SASL_PLAINTEXT:SASL_PLAINTEXT
inter.broker.listener.name=INTERNAL
sasl.enabled.mechanisms=SCRAM-SHA-512
listener.name.sasl_plaintext.scram-sha-512.sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required;
offsets.topic.replication.factor=1
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
auto.create.topics.enable=false
log.dirs=/tmp/bayn-kafka-data
EOF
cluster=$(/opt/kafka/bin/kafka-storage.sh random-uuid)
/opt/kafka/bin/kafka-storage.sh format --cluster-id "$cluster" --config /tmp/bayn-server.properties \
  --add-scram "SCRAM-SHA-512=[name=${BAYN_TEST_KAFKA_USERNAME},password=${BAYN_TEST_KAFKA_PASSWORD}]"
exec /opt/kafka/bin/kafka-server-start.sh /tmp/bayn-server.properties
')
if [[ "$mode" == receipts ]]; then
  cleanup_names+=("$restate_name")
  docker run --detach --name "$restate_name" --memory 2g --cpus 2 --pids-limit 512 \
    --label "bayn-receipt-fixture=$run_id" \
    --publish 127.0.0.1:8080:8080 --publish 127.0.0.1:9070:9070 \
    --add-host host.docker.internal:host-gateway "$restate_image" >/dev/null
fi
ready=false
for ((attempt = 1; attempt <= 60; attempt++)); do
  if [[ "$mode" == --capture-capacity ]] && (( SECONDS >= setup_deadline )); then
    echo 'Capacity fixture setup budget exhausted' >&2; exit 1
  fi
  if setup_step docker logs --tail 100 "$kafka_id" 2>&1 | grep -q 'Kafka Server started'; then
    if [[ "$mode" == --capture-capacity ]] || curl --max-time 2 --fail --silent http://127.0.0.1:9070/health >/dev/null; then ready=true; break; fi
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Native fixture startup timed out' >&2; exit 1; }

setup_step bun -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(Bun.YAML.parse(fs.readFileSync(process.argv[1], "utf8"))))' \
  "$root/argocd/applications/kafka/torghut-topics.yaml" > "$directory/source-topics.json"
setup_step bun -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(Bun.YAML.parse(fs.readFileSync(process.argv[1], "utf8"))))' \
  "$root/argocd/applications/bayn/execution-controller.yaml" > "$directory/execution-controller.json"

if [[ "$mode" == --capture-capacity ]]; then
  plan="$root/services/bayn/src/testing/capture-capacity-plan.json"
  node_image=$(node -e 'process.stdout.write(require(process.argv[1]).worker.image)' "$plan")
  plan_hash=$(sha256sum "$plan" | cut -d ' ' -f 1)
  printf 'Frozen capture capacity plan: %s\n' "$plan_hash"
  setup_step timeout 120s docker pull "$node_image" >/dev/null
  setup_step bun build "$root/services/bayn/src/testing/capture-capacity-native-node.mjs" --target=node \
    --external @platformatic/kafka --outdir "$directory"
  cleanup_names=("$capacity_name" "${cleanup_names[@]}")
  timeout --kill-after=5s 245s docker run --name "$capacity_name" --network host --read-only \
    --memory 1g --memory-swap 1g --cpus 2 --pids-limit 128 \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m --label "bayn-receipt-fixture=$run_id" \
    --env BAYN_TEST_KAFKA_USERNAME --env BAYN_TEST_KAFKA_PASSWORD --env BAYN_TEST_POSTGRES_URL \
    --volume "$root:$root:ro" --workdir "$root" "$node_image" \
    /bin/sh -ec 'timeout --version; exec timeout --signal=KILL 240s node "$@"' capacity-worker \
    "$directory/capture-capacity-native-node.js" "$plan" \
    "$directory/source-topics.json" "$directory/execution-controller.json" "$plan_hash"
  state=$(timeout --kill-after=1s 2s docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}} {{.RestartCount}}' "$capacity_name")
  [[ "$state" == 'false 0 0' ]] || { echo "Capacity container failed: $state" >&2; exit 1; }
  exit 0
fi

bun build "$root/services/bayn/src/testing/kafka-receipts-native-node.mjs" --target=node \
  --external @platformatic/kafka --outdir "$directory"
timeout 90s node "$directory/kafka-receipts-native-node.js" "$directory/source-topics.json" "$directory/execution-controller.json"
export BAYN_TEST_RESTATE_ADMIN_URL=http://127.0.0.1:9070
export BAYN_TEST_RESTATE_INGRESS_URL=http://127.0.0.1:8080
timeout 150s bun test "$root/services/bayn/src/restate/restate-execution-controller.integration.test.ts"
timeout 120s bun test "$root/services/bayn/src/restate/restate-broker-observations.integration.test.ts"

