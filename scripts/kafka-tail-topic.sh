#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: $0 <topic> [max_messages]

Environment variables:
  KAFKA_NAMESPACE         Namespace that hosts Kafka resources (default: kafka)
  KAFKA_USER_SECRET       Secret containing SASL credentials (default: user1)
  KAFKA_SASL_SECRET_KEY   Key within the secret that holds sasl.jaas.config (default: sasl.jaas.config)
  KAFKA_BOOTSTRAP         Bootstrap servers (default: kafka-kafka-bootstrap.kafka:9092)
  KAFKA_TOOLS_IMAGE       Kafka tools image (default: quay.io/strimzi/kafka:0.40.0-kafka-3.7.0)
  KAFKA_SASL_MECHANISM    SASL mechanism (default: SCRAM-SHA-512)
  KAFKA_SECURITY_PROTOCOL Security protocol (default: SASL_PLAINTEXT)
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

TOPIC=$1
MAX_MESSAGES=${2:-10}
NAMESPACE=${KAFKA_NAMESPACE:-kafka}
SECRET_NAME=${KAFKA_USER_SECRET:-user1}
SECRET_KEY=${KAFKA_SASL_SECRET_KEY:-sasl.jaas.config}
BOOTSTRAP=${KAFKA_BOOTSTRAP:-kafka-kafka-bootstrap.kafka:9092}
IMAGE=${KAFKA_TOOLS_IMAGE:-quay.io/strimzi/kafka:0.40.0-kafka-3.7.0}
SASL_MECHANISM=${KAFKA_SASL_MECHANISM:-SCRAM-SHA-512}
SECURITY_PROTOCOL=${KAFKA_SECURITY_PROTOCOL:-SASL_PLAINTEXT}
JAAS_FILE=sasl-jaas.config

if ! kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
  echo "Error: secret '$SECRET_NAME' not found in namespace '$NAMESPACE'" >&2
  exit 1
fi

POD_NAME="kafka-consumer-$(date +%s)"
MANIFEST=$(mktemp)

cleanup() {
  rm -f "$MANIFEST"
  kubectl -n "$NAMESPACE" delete pod "$POD_NAME" --ignore-not-found --now >/dev/null 2>&1 || true
}
trap cleanup EXIT

cat <<EOF_MANIFEST >"$MANIFEST"
apiVersion: v1
kind: Pod
metadata:
  name: $POD_NAME
  namespace: $NAMESPACE
  labels:
    app: kafka-console-consumer
spec:
  restartPolicy: Never
  containers:
    - name: kafka-tools
      image: $IMAGE
      command: ["sleep", "3600"]
      volumeMounts:
        - name: kafka-credentials
          mountPath: /etc/kafka-credentials
          readOnly: true
  volumes:
    - name: kafka-credentials
      secret:
        secretName: $SECRET_NAME
        items:
          - key: $SECRET_KEY
            path: $JAAS_FILE
EOF_MANIFEST

kubectl apply -f "$MANIFEST" >/dev/null
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod/"$POD_NAME" --timeout=120s >/dev/null

echo "Streaming $MAX_MESSAGES messages from topic '$TOPIC'" >&2
kubectl -n "$NAMESPACE" exec "$POD_NAME" -- env \
  BOOTSTRAP="$BOOTSTRAP" \
  TOPIC="$TOPIC" \
  MAX_MESSAGES="$MAX_MESSAGES" \
  SASL_MECHANISM="$SASL_MECHANISM" \
  SECURITY_PROTOCOL="$SECURITY_PROTOCOL" \
  JAAS_FILE="$JAAS_FILE" \
  /bin/sh <<'REMOTE'
set -euo pipefail
JAAS=$(cat "/etc/kafka-credentials/${JAAS_FILE}")
printf 'sasl.mechanism=%s\n' "$SASL_MECHANISM" >/tmp/client.properties
printf 'security.protocol=%s\n' "$SECURITY_PROTOCOL" >>/tmp/client.properties
printf 'sasl.jaas.config=%s\n' "$JAAS" >>/tmp/client.properties
/opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server "$BOOTSTRAP" \
  --topic "$TOPIC" \
  --from-beginning \
  --max-messages "$MAX_MESSAGES" \
  --property print.key=true \
  --property key.separator=' : ' \
  --consumer.config /tmp/client.properties
REMOTE
