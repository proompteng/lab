# Grafana Alloy Ingester on macOS

This guide covers installing and running the Grafana Alloy ingester locally on macOS so you can ship logs (and optionally metrics) to the lab's observability stack.

## Version alignment

Match the local binary to the cluster version. Current deployments use `grafana/alloy:v1.11.2` (see `argocd/applications/*/alloy-deployment.yaml`). If you upgrade locally, keep the cluster manifests in sync.

## Install

### Option A: Homebrew (preferred when available)

If your Homebrew catalog includes Alloy, install and confirm the binary:
```bash
brew install grafana/alloy/alloy
alloy --version
```

### Option B: Download the macOS release tarball

Download the Grafana Alloy v1.11.2 macOS tarball from the official release page, then unpack and place the `alloy` binary on your PATH:
```bash
tar -xzf alloy-darwin-*.tar.gz
sudo install -m 0755 alloy /usr/local/bin/alloy
alloy --version
```

## Configure

Create a local River config. Start with a minimal log pipeline and adjust labels/paths for your machine.

1) Create a config directory:
```bash
mkdir -p ~/.config/alloy
```

2) Save a config (example below) as `~/.config/alloy/config.river`:
```river
logging {
  level  = "info"
  format = "logfmt"
}

loki.source.file "local_logs" {
  targets = [
    { __path__ = "/var/log/system.log", job = "macos-system" },
    { __path__ = "/var/log/*.log", job = "macos-varlog" },
  ]
  forward_to = [loki.process.local.receiver]
}

loki.process "local" {
  stage.static_labels {
    values = {
      host        = "your-hostname",
      environment = "local",
    }
  }

  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "http://localhost:3100/loki/api/v1/push"
  }
}
```

Notes:
- Replace `your-hostname` with a stable name for your machine.
- If you want to ship other files, add additional `__path__` targets.
- River syntax requires commas between key/value pairs inside `values {}` blocks (including the last entry).

## Run

Start Alloy in the foreground:
```bash
alloy run ~/.config/alloy/config.river
```

## Pointing to the cluster Loki gateway

For local development, port-forward the Loki gateway so the `loki.write` endpoint is reachable:
```bash
kubectl -n observability get svc observability-loki-loki-distributed-gateway
kubectl -n observability port-forward svc/observability-loki-loki-distributed-gateway 3100:<service-port>
```

Update the `loki.write` URL if you use a different local port.

## Verify

- Alloy logs should show successful `POST /loki/api/v1/push` lines.
- In Grafana, query by labels you set (`host`, `environment`, `job`).

## Troubleshooting

- **No logs arriving:** confirm the file paths exist and are readable; macOS system logs may require `sudo` or explicit file permissions.
- **Crash on startup:** check for missing commas in `values {}` blocks; River is strict about commas.
- **Permission errors reading /var/log:** run Alloy with elevated privileges or point it at log files you own.

## Uninstall

- Homebrew: `brew uninstall grafana/alloy/alloy`
- Manual install: remove `/usr/local/bin/alloy` and delete `~/.config/alloy` if no longer needed.
