#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SAIGAK_GRAFANA_URL:-}" ]]; then
  echo "set SAIGAK_GRAFANA_URL to run this check" >&2
  exit 1
fi

grafana_url="${SAIGAK_GRAFANA_URL%/}"
grafana_user="${SAIGAK_GRAFANA_USER:-admin}"
grafana_password="${SAIGAK_GRAFANA_PASSWORD:-changeme}"

datasource_id="${SAIGAK_GRAFANA_DS_ID:-}"
export SAIGAK_GRAFANA_DS_NAME="${SAIGAK_GRAFANA_DS_NAME:-}"
export SAIGAK_GRAFANA_DS_TYPE="${SAIGAK_GRAFANA_DS_TYPE:-prometheus}"

if [[ -z "$datasource_id" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "set SAIGAK_GRAFANA_DS_ID or install python3 to auto-discover datasource" >&2
    exit 1
  fi
  datasources=$(curl -fsS -u "${grafana_user}:${grafana_password}" "${grafana_url}/api/datasources")
  export SAIGAK_GRAFANA_DS_JSON="$datasources"
  datasource_id=$(python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ.get("SAIGAK_GRAFANA_DS_JSON", "[]"))
name = os.environ.get("SAIGAK_GRAFANA_DS_NAME", "")
dtype = os.environ.get("SAIGAK_GRAFANA_DS_TYPE", "prometheus")

if name:
    for ds in data:
        if ds.get("name") == name:
            print(ds.get("id", ""))
            sys.exit(0)

for ds in data:
    if ds.get("type") == dtype:
        print(ds.get("id", ""))
        sys.exit(0)
PY
  )
  unset SAIGAK_GRAFANA_DS_JSON
fi

if [[ -z "$datasource_id" ]]; then
  echo "unable to determine Grafana datasource id; set SAIGAK_GRAFANA_DS_ID or SAIGAK_GRAFANA_DS_NAME" >&2
  exit 1
fi

query='ollama_requests_total'

curl -fsS -u "${grafana_user}:${grafana_password}" \
  "${grafana_url}/api/datasources/proxy/${datasource_id}/api/v1/query?query=${query}"
