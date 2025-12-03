#!/usr/bin/env bash
set -euo pipefail

KAFKA_NS=${KAFKA_NS:-kafka}
TORGHUT_NS=${TORGHUT_NS:-torghut}
PORT=${PORT:-19092}
SYMBOLS=${SYMBOLS:-SPY}
TOPIC=${TOPIC:-alpaca.trades.v1}
FORWARDER_SECRET=${FORWARDER_SECRET:-torghut-forwarder}
ALPACA_SECRET=${ALPACA_SECRET:-torghut-alpaca}

cleanup() {
  if [[ -n "${PORT_FWD_PID:-}" ]] && ps -p ${PORT_FWD_PID} >/dev/null 2>&1; then
    kill ${PORT_FWD_PID}
  fi
}
trap cleanup EXIT

printf "\n==> Port-forwarding Kafka bootstrap on localhost:%s\n" "$PORT"
(kubectl -n "$KAFKA_NS" port-forward svc/kafka-kafka-bootstrap "$PORT":9092 >/tmp/torghut-forwarder-portforward.log 2>&1 &
 echo $! > /tmp/torghut-forwarder-portforward.pid
) &
sleep 3
PORT_FWD_PID=$(cat /tmp/torghut-forwarder-portforward.pid)

printf "==> Reading Kafka credentials from %s/%s\n" "$TORGHUT_NS" "$FORWARDER_SECRET"
USERNAME=$(kubectl -n "$TORGHUT_NS" get secret "$FORWARDER_SECRET" -o jsonpath='{.data.username}' | base64 -d)
PASSWORD=$(kubectl -n "$TORGHUT_NS" get secret "$FORWARDER_SECRET" -o jsonpath='{.data.password}' | base64 -d)

cat >/tmp/torghut-forwarder-kafka.properties <<CONFIG
security.protocol=SASL_PLAINTEXT
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="${USERNAME}" password="${PASSWORD}";
CONFIG

printf "==> Reading Alpaca credentials from %s/%s\n" "$TORGHUT_NS" "$ALPACA_SECRET"
export ALPACA_API_KEY_ID=$(kubectl -n "$TORGHUT_NS" get secret "$ALPACA_SECRET" -o jsonpath='{.data.APCA_API_KEY_ID}' | base64 -d)
export ALPACA_SECRET_KEY=$(kubectl -n "$TORGHUT_NS" get secret "$ALPACA_SECRET" -o jsonpath='{.data.APCA_API_SECRET_KEY}' | base64 -d)
export ALPACA_SYMBOLS=${SYMBOLS}
export KAFKA_BOOTSTRAP_SERVERS=127.0.0.1:${PORT}
export KAFKA_USERNAME=${USERNAME}
export KAFKA_PASSWORD=${PASSWORD}
export KAFKA_SECURITY_PROTOCOL=SASL_PLAINTEXT
export KAFKA_SASL_MECHANISM=SCRAM-SHA-512

printf "==> Starting forwarder locally with symbols %s (Ctrl+C to stop)\n" "$SYMBOLS"
(cd services/torghut-forwarder && uv run torghut_forwarder/app.py >/tmp/torghut-forwarder.log 2>&1 & echo $! > /tmp/torghut-forwarder.pid)
sleep 10

printf "==> Consuming a few messages from %s to verify envelope...\n" "$TOPIC"
kafka-console-consumer \
  --bootstrap-server 127.0.0.1:${PORT} \
  --topic "$TOPIC" \
  --consumer.config /tmp/torghut-forwarder-kafka.properties \
  --from-beginning \
  --max-messages 5

echo "Logs at /tmp/torghut-forwarder.log and port-forward at /tmp/torghut-forwarder-portforward.log"
