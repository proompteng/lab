#!/usr/bin/env bash
set -euo pipefail

REGISTRY_URL="${KARAPACE_URL:-http://karapace.kafka.svc:8081}"
SCHEMA_DIR="$(dirname "$0")/schemas"

register() {
  local subject=$1
  local file=$2
  echo "Registering $subject from $file"
  curl -sS -X POST "${REGISTRY_URL}/subjects/${subject}/versions" \
    -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
    --data @<(jq -n --arg schema "$(jq -c . < "$file")" '{schema: $schema}')
}

register "torghut.ta.bars.1s.v1-value" "$SCHEMA_DIR/ta-bars-1s.avsc"
register "torghut.ta.signals.v1-value" "$SCHEMA_DIR/ta-signals.avsc"
register "torghut.ta.status.v1-value" "$SCHEMA_DIR/ta-status.avsc"

echo "Done"
