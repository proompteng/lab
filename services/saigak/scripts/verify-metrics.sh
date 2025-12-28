#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SAIGAK_GRAFANA_URL:-}" ]]; then
  echo "set SAIGAK_GRAFANA_URL to run this check" >&2
  exit 1
fi

grafana_url="${SAIGAK_GRAFANA_URL%/}"
grafana_user="${SAIGAK_GRAFANA_USER:-admin}"
grafana_password="${SAIGAK_GRAFANA_PASSWORD:-changeme}"

query='ollama_requests_total'

curl -fsS -u "${grafana_user}:${grafana_password}" \
  "${grafana_url}/api/datasources/proxy/2/api/v1/query?query=${query}"
