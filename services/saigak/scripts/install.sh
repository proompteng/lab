#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[saigak] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[saigak] missing required command: $1" >&2
    exit 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

log "installing saigak from ${SERVICE_DIR}"

require_cmd curl
require_cmd sudo

if ! command -v ollama >/dev/null 2>&1; then
  log "ollama not found, installing"
  curl -fsSL https://ollama.com/install.sh | sh
fi

log "installing systemd override and ollama env"
sudo install -d /etc/saigak
sudo install -m 0644 "${SERVICE_DIR}/config/ollama.env" /etc/saigak/ollama.env
sudo install -d /etc/systemd/system/ollama.service.d
sudo install -m 0644 "${SERVICE_DIR}/systemd/ollama-saigak.conf" /etc/systemd/system/ollama.service.d/99-saigak.conf

sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama

if [[ -n "${SAIGAK_MODELS:-}" ]]; then
  log "pulling models: ${SAIGAK_MODELS}"
  for model in ${SAIGAK_MODELS//,/ }; do
    sudo -u ollama /usr/local/bin/ollama pull "${model}"
  done
fi

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "[saigak] docker compose plugin is required" >&2
  exit 1
fi

compose_files=("-f" "${SERVICE_DIR}/docker-compose.yml")
if [[ "${SAIGAK_ENABLE_NGINX:-}" == "1" ]]; then
  log "nginx enabled"
  compose_files+=("-f" "${SERVICE_DIR}/docker-compose.nginx.yml")
fi

log "starting saigak containers"
docker compose "${compose_files[@]}" up -d --build

if [[ -n "${SAIGAK_GRAFANA_URL:-}" ]]; then
  grafana_url="${SAIGAK_GRAFANA_URL}"
  grafana_user="${SAIGAK_GRAFANA_USER:-admin}"
  grafana_password="${SAIGAK_GRAFANA_PASSWORD:-changeme}"
  log "importing grafana dashboard into ${grafana_url}"
  curl -fsS -u "${grafana_user}:${grafana_password}" \
    -H "Content-Type: application/json" \
    -d "@${SERVICE_DIR}/grafana/ollama-throughput-proof.json" \
    "${grafana_url%/}/api/dashboards/db"
else
  log "skipping grafana import (set SAIGAK_GRAFANA_URL to enable)"
fi

log "install complete"
