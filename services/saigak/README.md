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
Default models: `qwen3-coder:30b-a3b-q4_K_M`, `qwen3-embedding:0.6b` (set `SAIGAK_SKIP_MODELS=1` to skip).

## Requirements

- Docker with the compose plugin (the Harvester `ubuntu-docker` cloud-init already installs this)
- systemd
- network access to LGTM endpoints (Tailscale DNS names `mimir`, `tempo`, and `grafana`)
If Docker is missing, install it first or use the `ubuntu-docker` cloud-init profile.

## Configuration

- `services/saigak/config/ollama.env`
  - OLLAMA runtime settings (parallelism, queue, keep alive)
- `services/saigak/config/alloy/config.alloy`
  - OTLP receiver and exporters to LGTM (`http://mimir/otlp`, `http://tempo`)
- `services/saigak/config/nginx/nginx.conf`
  - Optional reverse proxy (listens on `:8080`)

Systemd drop-in installed at:
- `/etc/systemd/system/ollama.service.d/99-saigak.conf`

## Grafana dashboard

The dashboard JSON is stored at:
- `services/saigak/grafana/ollama-throughput-proof.json`

The install script imports it when `SAIGAK_GRAFANA_URL` is set.

## Load test

Run a quick throughput check against the proxy:

```bash
./services/saigak/scripts/load-test.py \
  --model qwen3-coder:30b-a3b-q4_K_M \
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
