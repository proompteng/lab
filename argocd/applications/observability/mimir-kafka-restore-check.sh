#!/usr/bin/env bash
set -euo pipefail

# Run only against the isolated snapshot clone. Never format a missing log.
data=/var/lib/kafka/data
receipt=/var/lib/kafka/upgrade-proof-4.3.1
expected_cluster=5L6g3nShT-eMCtK--X86sw
test -s "$data/meta.properties"
test "$(sed -n 's/^cluster.id=//p' "$data/meta.properties")" = "$expected_cluster"
test "$(sed -n 's/^node.id=//p' "$data/meta.properties")" = 0
test -d "$data/__cluster_metadata-0"
test -n "$(find "$data" -maxdepth 1 -type d -name 'mimir-ingest-*' -print -quit)"
test ! -e "$receipt/accepted"
mkdir -p "$receipt"
cp "$data/meta.properties" "$receipt/meta.properties.before"

broker_pid=
cleanup() {
  if [[ -n "$broker_pid" ]] && kill -0 "$broker_pid" 2>/dev/null; then
    kill -TERM "$broker_pid"
    wait "$broker_pid" || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT
/etc/kafka/docker/run > /tmp/broker.log 2>&1 &
broker_pid=$!
deadline=$((SECONDS + 300))
until (exec 3<>/dev/tcp/127.0.0.1/9092) 2>/dev/null; do
  if ! kill -0 "$broker_pid" 2>/dev/null || (( SECONDS >= deadline )); then
    tail -n 60 /tmp/broker.log
    exit 1
  fi
  sleep 2
done

kafka=/opt/kafka/bin
"$kafka/kafka-metadata-quorum.sh" --bootstrap-server 127.0.0.1:9092 describe --status > "$receipt/quorum.txt"
"$kafka/kafka-topics.sh" --bootstrap-server 127.0.0.1:9092 --describe > "$receipt/topics.txt"
"$kafka/kafka-get-offsets.sh" --bootstrap-server 127.0.0.1:9092 --time -1 > "$receipt/end-offsets.txt"
"$kafka/kafka-features.sh" --bootstrap-server 127.0.0.1:9092 describe > "$receipt/features.txt"
test "$(awk '/^ClusterId:/ {print $2}' "$receipt/quorum.txt")" = "$expected_cluster"
test "$(awk '/^LeaderId:/ {print $2}' "$receipt/quorum.txt")" = 0
test "$(wc -l < "$receipt/end-offsets.txt" | tr -d ' ')" = 150
test "$(awk -F: '$1 == "mimir-ingest" {n++} END {print n+0}' "$receipt/end-offsets.txt")" = 100
test "$(awk -F: '$1 == "__consumer_offsets" {n++} END {print n+0}' "$receipt/end-offsets.txt")" = 50
# Read an actual retained record without writing its metric payload to logs.
"$kafka/kafka-console-consumer.sh" --bootstrap-server 127.0.0.1:9092 \
  --topic mimir-ingest --partition 0 --offset earliest --max-messages 1 \
  --timeout-ms 30000 --property print.value=false --property print.key=false \
  --property print.offset=true > "$receipt/record-offset.txt" 2> "$receipt/consumer-status.txt"
test -s "$receipt/record-offset.txt"
grep -q 'Processed a total of 1 messages' "$receipt/consumer-status.txt"
cmp "$receipt/meta.properties.before" "$data/meta.properties"
kill -TERM "$broker_pid"
broker_status=0
wait "$broker_pid" || broker_status=$?
broker_pid=
if [[ "$broker_status" != 0 && "$broker_status" != 143 ]]; then
  printf 'Kafka exited unexpectedly during shutdown: %s\n' "$broker_status" >&2
  exit 1
fi
# A JVM shutdown hook can finish normally and still return 128 + SIGTERM.
# Require Kafka's completed shutdown marker as well as the expected status.
grep -q 'BrokerServer.*shut down completed' /tmp/broker.log
if grep -Eq 'Fatal error during (broker|controller) shutdown' /tmp/broker.log; then
  exit 1
fi
cp /tmp/broker.log "$receipt/broker.log"
sync
printf '%s\n' 'Kafka 4.3.1 restored the original cluster, two topics, 150 partitions and a retained metric record.' > "$receipt/accepted"
cat "$receipt/accepted"
# Completed Pods cannot be exec'd. Expose bounded metadata receipts through
# Job logs so the operator can compare every partition with the live baseline.
# These files contain identifiers and offsets, never metric record payloads.
for name in meta.properties.before quorum.txt topics.txt end-offsets.txt features.txt record-offset.txt; do
  printf '\nBEGIN_KAFKA_RESTORE_RECEIPT %s\n' "$name"
  cat "$receipt/$name"
  printf '\nEND_KAFKA_RESTORE_RECEIPT %s\n' "$name"
done
