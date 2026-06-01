# Miel (Alpaca Backtesting Service)

This directory defines the Kubernetes manifests synced by Argo CD for the `miel` trading/backtest service.

## Components

- `ConfigMap` (`miel-config`) — default non-secret configuration values such as Alpaca endpoints and request limits.
- `Deployment` — runs the Go service image `registry.ide-newton.ts.net/lab/miel:0.1.0`, exposing port 8080 with readiness/liveness probes on `/healthz`.
- `Service` — stable ClusterIP service on port 80 pointing to the container’s port 8080.

## Secrets

The deployment expects a `Secret` named `miel-secrets` in the same namespace with keys:

- `alpaca-api-key`
- `alpaca-secret-key`

Provision these via SealedSecrets or your preferred secret management flow. The values populate the `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` environment variables.

## TigerBeetle Integration

TigerBeetle support is disabled by default (`TIGERBEETLE_ENABLED=false`). Lab no longer provisions a local TigerBeetle cluster for Miel. If Miel needs TigerBeetle later, deploy a cluster from the standalone `proompteng/tigresse` operator repository and then update `miel-config` with:

- `TIGERBEETLE_ENABLED=true`
- `TIGERBEETLE_ADDRESSES` (comma-separated replica addresses)
- `TIGERBEETLE_CLUSTER_ID`
- `TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID` and `TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID`
- Optionally override `TIGERBEETLE_LEDGER`, `TIGERBEETLE_ORDER_CODE`, `TIGERBEETLE_BACKTEST_CODE`, `TIGERBEETLE_AMOUNT_SCALE`, and the backtest-specific account IDs.

Restart the deployment after updating the ConfigMap so the new environment variables are applied.

## Observability (Observability Stack)

`miel-config` now hydrates OpenTelemetry defaults that point at the in-cluster observability stack:

- `OTEL_SERVICE_NAME=miel`
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
- OTLP endpoints for traces (`observability-tempo-distributor`), metrics (`observability-mimir-nginx`), and logs (`observability-loki-loki-distributed-gateway`).

Override these values as needed for other environments, then restart the deployment (or let Argo CD roll pods) to pick up the new telemetry configuration.

## Image Updates

Use `scripts/build-miel.sh <tag>` to build and push a new container image. Update the `image` field in `deployment.yaml` (or manage via Argo CD Image Updater) to roll out the new version.
