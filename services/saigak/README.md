# Saigak

Saigak packages the Ollama throughput tuning + LGTM observability wiring into a
reproducible setup. It installs Ollama with a localhost bind, runs an
OpenTelemetry-enabled proxy on port 11434, and ships metrics/traces to the LGTM
stack via Grafana Alloy.

## Components

- **Ollama**: runs on `127.0.0.1:11435` (systemd)
- **Ollama proxy**: listens on `0.0.0.0:11434` and exports OTEL metrics/traces
- **Alloy**: receives OTLP and forwards to Mimir/Tempo
- **Optional Nginx**: reverse proxy on `:8080` (disabled by default)

## Quick install

From the repo root:

```bash
SAIGAK_GRAFANA_URL=http://grafana \
SAIGAK_GRAFANA_USER=admin \
SAIGAK_GRAFANA_PASSWORD=changeme \
./services/saigak/scripts/install.sh
```

Optional: enable Nginx by setting `SAIGAK_ENABLE_NGINX=1`.
Optional: pre-pull models by setting `SAIGAK_MODELS` (comma-separated).
Default base models (used to build service aliases): `qwen3:30b-a3b`, `qwen3-embedding:8b`
(set `SAIGAK_SKIP_MODELS=1` to skip).
Service aliases are created by default (`SAIGAK_CREATE_TUNED_MODELS=1`):
`qwen3-main-saigak:30b-a3b`, `qwen3-embedding-saigak:8b`.
Base tags are pruned after alias creation unless `SAIGAK_PRUNE_BASE_MODELS=0`, and legacy
`qwen3-coder-saigak:*` / `qwen3-embedding-saigak:0.6b` tags are removed during migration.

## Requirements

- Docker with the compose plugin (the Harvester `ubuntu-docker` cloud-init already installs this)
- systemd
- network access to LGTM endpoints (Tailscale DNS names `mimir`, `tempo`, and `grafana`)
  If Docker is missing, install it first or use the `ubuntu-docker` cloud-init profile.

## Configuration

- `services/saigak/config/ollama.env`
  - OLLAMA runtime settings (32K context target, queueing, residency)
- `services/saigak/config/models/*.modelfile`
  - Service-owned aliases for `Qwen3-30B-A3B` and `Qwen3-Embedding-8B`
- `services/saigak/config/alloy/config.alloy`
  - OTLP receiver and exporters to LGTM (`http://mimir/otlp`, `http://tempo`)
- `services/saigak/config/nginx/nginx.conf`
  - Optional reverse proxy (listens on `:8080`)

Systemd drop-in installed at:

- `/etc/systemd/system/ollama.service.d/99-saigak.conf`

## Grafana dashboard

The install script can import a dashboard when `SAIGAK_GRAFANA_URL` is set.
Provide the dashboard JSON path via `SAIGAK_GRAFANA_DASHBOARD_JSON`.

## Load test

Run a quick throughput check against the proxy:

```bash
./services/saigak/scripts/load-test.py \
  --model qwen3-main-saigak:30b-a3b \
  --duration 60 \
  --concurrency 8
```

## Verify metrics

```bash
SAIGAK_GRAFANA_URL=http://grafana \
SAIGAK_GRAFANA_USER=admin \
SAIGAK_GRAFANA_PASSWORD=changeme \
./services/saigak/scripts/verify-metrics.sh
```
