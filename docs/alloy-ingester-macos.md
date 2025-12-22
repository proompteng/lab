# Grafana Alloy on macOS

This guide covers installing and running Grafana Alloy locally on macOS so you can ship OTLP logs (and optionally traces/metrics) to the lab's observability stack over Tailscale.

## Version alignment

Match the local binary to the cluster version. Current deployments use `grafana/alloy:v1.11.2` (see `argocd/applications/*/alloy-deployment.yaml`). If Homebrew is ahead, install the pinned tarball instead or upgrade the cluster manifests in sync.

## Install

### Option A: Homebrew (preferred when available)

Install the Homebrew formula and confirm the binary:
```bash
brew install grafana-alloy
/opt/homebrew/opt/grafana-alloy/bin/alloy --version
```

Homebrew stores configuration in `/opt/homebrew/etc/grafana-alloy` and data in
`/opt/homebrew/var/lib/grafana-alloy/data`. The service runs `alloy run /opt/homebrew/etc/grafana-alloy`,
so only `*.alloy` files in that directory are loaded.

### Option B: Download the macOS release tarball

Download the Grafana Alloy v1.11.2 macOS tarball from the official release page, then unpack and place the `alloy` binary on your PATH:
```bash
tar -xzf alloy-darwin-*.tar.gz
sudo install -m 0755 alloy /usr/local/bin/alloy
alloy --version
```

## Configure

Homebrew runs Alloy from `/opt/homebrew/etc/grafana-alloy/config.alloy` (this is the file `brew services` uses). The current config on this host forwards OTLP logs to Loki over Tailscale (via the Loki push API) and keeps trace/metric exporters commented out.

1) Ensure the config directory exists:
```bash
mkdir -p /opt/homebrew/etc/grafana-alloy
```

2) Save the config below to `/opt/homebrew/etc/grafana-alloy/config.alloy`:
```alloy
logging {
  level = "info"
}

otelcol.receiver.otlp "codex" {
  http {
    endpoint = "127.0.0.1:4318"
  }

  output {
    logs = [otelcol.processor.batch.default.input]
  }
}

otelcol.processor.batch "default" {
  output {
    logs = [otelcol.exporter.loki.default.input]
  }
}

otelcol.exporter.loki "default" {
  forward_to = [loki.write.tailscale.receiver]
}

loki.write "tailscale" {
  endpoint {
    url = "http://loki/loki/api/v1/push"
  }
}

// Uncomment if you want to forward traces/metrics from local apps too.
// otelcol.exporter.otlphttp "tempo" {
//   client {
//     endpoint = "http://tempo"
//   }
// }
//
// otelcol.exporter.otlphttp "mimir" {
//   client {
//     endpoint = "http://mimir/otlp"
//   }
// }
```

Notes:
- The OTLP HTTP receiver listens on `127.0.0.1:4318` for local apps (for example, Codex).
- Loki, Tempo, and Mimir are exposed on the Tailscale network as `http://loki`, `http://tempo`, and `http://mimir`.
- Loki OTLP ingestion is not enabled in this stack, so we send logs through the Loki push API at `http://loki/loki/api/v1/push`. Tempo expects OTLP traces at `/v1/traces`, and Mimir expects OTLP metrics at `/v1/metrics`.

### Codex OTEL config (this host)

Codex is configured to emit OTLP logs locally so Alloy can forward them to Loki. The config lives at `~/.codex/config.toml`:
```toml
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }
```

Keep the endpoint on `127.0.0.1:4318` to match the Alloy `otelcol.receiver.otlp` block.

To label logs under `service="codex"` in Loki, set the originator override when launching Codex:
```bash
export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex
```

## Run

Start Alloy in the foreground:
```bash
/opt/homebrew/opt/grafana-alloy/bin/alloy run \
  --storage.path=/opt/homebrew/var/lib/grafana-alloy/data \
  /opt/homebrew/etc/grafana-alloy/config.alloy
```

Or start it as a background service:
```bash
brew services start grafana-alloy
```

## Pointing to the cluster over Tailscale

Make sure your machine is on Tailscale. The Tailscale load balancers publish the endpoints:
- Loki logs: `http://loki/loki/api/v1/push`
- Tempo traces: `http://tempo` (OTLP HTTP `/v1/traces`)
- Mimir metrics: `http://mimir/otlp` (OTLP HTTP `/v1/metrics`)

## Verify

- Alloy logs should show successful sends to `http://loki/loki/api/v1/push` once logs flow.
- Smoke-test Loki: `curl -s http://loki/loki/api/v1/status/buildinfo`.
- Smoke-test Tempo: `curl -s http://tempo/api/status/buildinfo`.
- Smoke-test Mimir: `curl -s http://mimir/api/v1/status/buildinfo`.

## Troubleshooting

- **No logs arriving:** confirm your local app is exporting OTLP HTTP to `127.0.0.1:4318` and Alloy is running.
- **Connection errors:** verify Tailscale is up and the `loki`, `tempo`, `mimir` hostnames resolve.

## Uninstall

- Homebrew: `brew uninstall grafana-alloy`
- Manual install: remove `/usr/local/bin/alloy` and delete `~/.config/alloy` if no longer needed.
