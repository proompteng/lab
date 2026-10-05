#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
run_id=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')
export BAYN_TEST_KAFKA_USERNAME="bayn-fixture-${run_id}"
export BAYN_TEST_KAFKA_PASSWORD
BAYN_TEST_KAFKA_PASSWORD=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then printf '::add-mask::%s\n' "$BAYN_TEST_KAFKA_PASSWORD"; fi
directory=$(mktemp -d "${root}/services/bayn/.native-receipts.XXXXXX")
kafka_name="bayn-receipts-kafka-${run_id}"
restate_name="bayn-receipts-restate-${run_id}"
kafka_id=
cleanup() {
  status=$?
  for name in "$kafka_name" "$restate_name"; do
    identity=$(docker inspect --format '{{.Id}} {{index .Config.Labels "bayn-receipt-fixture"}}' "$name" 2>/dev/null) || continue
    read -r id owner <<< "$identity"
    if [[ "$owner" != "$run_id" || ! "$id" =~ ^[0-9a-f]{64}$ ]]; then continue; fi
    if [[ "$status" != 0 ]]; then docker logs --tail 100 "$id" >&2 || true; fi
    docker rm --force "$id" >/dev/null 2>&1 || true
  done
  rm -rf "$directory"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

kafka_image='apache/kafka:4.1.1@sha256:0bc1bb2478f45b6cea78864df86acdc11e8df2c5172477819a4d12942cbe5d40'
restate_image='docker.restate.dev/restatedev/restate:1.7.9@sha256:3efeb748ebea40f0a895ca858321d0ef33396d40fe6d16ec593cd5553eb98441'
timeout 180s docker pull "$kafka_image" >/dev/null
timeout 180s docker pull "$restate_image" >/dev/null
kafka_id=$(docker run --detach --name "$kafka_name" --memory 2g --cpus 2 --pids-limit 512 \
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
docker run --detach --name "$restate_name" --memory 2g --cpus 2 --pids-limit 512 \
  --label "bayn-receipt-fixture=$run_id" \
  --publish 127.0.0.1:8080:8080 --publish 127.0.0.1:9070:9070 \
  --add-host host.docker.internal:host-gateway "$restate_image" >/dev/null
ready=false
for ((attempt = 1; attempt <= 60; attempt++)); do
  if docker logs --tail 100 "$kafka_id" 2>&1 | grep -q 'Kafka Server started'; then
    if curl --max-time 2 --fail --silent http://127.0.0.1:9070/health >/dev/null; then ready=true; break; fi
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Native fixture startup timed out' >&2; exit 1; }

bun -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(Bun.YAML.parse(fs.readFileSync(process.argv[1], "utf8"))))' \
  "$root/argocd/applications/kafka/torghut-topics.yaml" > "$directory/source-topics.json"
bun -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(Bun.YAML.parse(fs.readFileSync(process.argv[1], "utf8"))))' \
  "$root/argocd/applications/bayn/execution-controller.yaml" > "$directory/execution-controller.json"

bun build "$root/services/bayn/src/testing/kafka-receipts-native-node.mjs" --target=node \
  --external @platformatic/kafka --outdir "$directory"
timeout 90s node "$directory/kafka-receipts-native-node.js" "$directory/source-topics.json" "$directory/execution-controller.json"
export BAYN_TEST_RESTATE_ADMIN_URL=http://127.0.0.1:9070
export BAYN_TEST_RESTATE_INGRESS_URL=http://127.0.0.1:8080
timeout 150s bun test "$root/services/bayn/src/restate/restate-execution-controller.integration.test.ts"
timeout 120s bun test "$root/services/bayn/src/restate/restate-broker-observations.integration.test.ts"

