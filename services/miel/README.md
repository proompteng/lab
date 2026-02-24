# Miel Service

A Go service that integrates with the [Alpaca Trading API](https://docs.alpaca.markets/) to backtest simple trading strategies and place real or paper-market orders. The service exposes an HTTP API for:

- Triggering historical simulations (`POST /api/v1/backtests`) using Alpaca market data
- Submitting market orders to Alpaca (`POST /api/v1/orders/market`)
- Health checking (`GET /healthz`)

## Project Layout

```
services/miel/
├── Dockerfile     # Multi-stage build for the ARM64 container image
├── internal/
│   ├── alpaca/    # Lightweight wrappers around Alpaca trading and market data clients
│   ├── backtest/  # Strategy engine and backtest result types
│   ├── config/    # Environment variable driven configuration loader
│   ├── server/    # Gin HTTP server wiring and handlers
│   └── trading/   # Trading service with input validation helpers
├── main.go        # Service entrypoint and HTTP server bootstrap
├── go.mod / go.sum
└── README.md
```

## Configuration

Set the following environment variables before running the service. Paper-trading endpoints are used by default.

| Variable                              | Description                                           | Default                                                                 |
| ------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `HTTP_PORT`                           | HTTP listen port. Prefix with `:` if desired.         | `8080`                                                                  |
| `ALPACA_API_KEY`                      | Alpaca API key (paper or live).                       | _required_                                                              |
| `ALPACA_SECRET_KEY`                   | Alpaca API secret.                                    | _required_                                                              |
| `ALPACA_BASE_URL`                     | Trading REST base URL.                                | `https://paper-api.alpaca.markets`                                      |
| `ALPACA_DATA_BASE_URL`                | Market data REST base URL.                            | `https://data.alpaca.markets`                                           |
| `ALPACA_REQUEST_TIMEOUT_SECONDS`      | Timeout applied to outbound Alpaca calls.             | `30`                                                                    |
| `BACKTEST_MAX_BARS`                   | Maximum bars fetched per backtest request.            | `5000`                                                                  |
| `OTEL_SERVICE_NAME`                   | Service name reported to OpenTelemetry/observability. | `miel`                                                                  |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | OTLP transport protocol.                              | `http/protobuf`                                                         |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | OTLP traces endpoint (observability Tempo).           | `http://observability-tempo-distributor.observability:4318`             |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | OTLP metrics endpoint (observability Mimir).          | `http://observability-mimir-nginx.observability/otlp`                   |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | OTLP logs endpoint (observability Loki).              | `http://observability-loki-loki-distributed-gateway.observability/otlp` |

### TigerBeetle ledger (optional)

Enable ledger recording to [TigerBeetle](https://docs.tigerbeetle.com/) by setting `TIGERBEETLE_ENABLED=true` and supplying the additional parameters below. Orders and backtest net P&L are written as transfers.

| Variable                                 | Description                                                                      | Default                 |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ----------------------- |
| `TIGERBEETLE_ENABLED`                    | Toggle TigerBeetle integration.                                                  | `false`                 |
| `TIGERBEETLE_ADDRESSES`                  | Comma-separated replica addresses (e.g., `127.0.0.1:3000`).                      | _required when enabled_ |
| `TIGERBEETLE_CLUSTER_ID`                 | Cluster identifier provided when bootstrapping TigerBeetle.                      | _required when enabled_ |
| `TIGERBEETLE_LEDGER`                     | Ledger identifier used for transfers.                                            | `1`                     |
| `TIGERBEETLE_ORDER_CODE`                 | Transfer code for Alpaca order entries.                                          | `100`                   |
| `TIGERBEETLE_BACKTEST_CODE`              | Transfer code for backtest P&L entries.                                          | `200`                   |
| `TIGERBEETLE_AMOUNT_SCALE`               | Decimal precision (power of 10) applied before storing amounts.                  | `6`                     |
| `TIGERBEETLE_ORDER_DEBIT_ACCOUNT_ID`     | Account debited for buy orders (credited for sells).                             | _required when enabled_ |
| `TIGERBEETLE_ORDER_CREDIT_ACCOUNT_ID`    | Account credited for buy orders (debited for sells).                             | _required when enabled_ |
| `TIGERBEETLE_BACKTEST_DEBIT_ACCOUNT_ID`  | Account debited for profitable backtests (defaults to order debit when unset).   | _optional_              |
| `TIGERBEETLE_BACKTEST_CREDIT_ACCOUNT_ID` | Account credited for profitable backtests (defaults to order credit when unset). | _optional_              |

## Developing Locally

```bash
# Install dependencies
bun install  # repo root

# Tidy the Go module
cd services/miel
go mod tidy

# Run tests
go test ./...

# Start the service (example env vars)
export ALPACA_API_KEY=... \
       ALPACA_SECRET_KEY=... \
       HTTP_PORT=8080

go run ./...
```

## Building & Publishing

Use the helper script to build and push an ARM64 image to the registry:

```bash
./scripts/build-miel.sh 0.1.0   # optional tag argument
```

The Dockerfile is multi-stage and emits a distroless image sized for the ARM-based cluster.

## HTTP API

### `POST /api/v1/backtests`

Request body:

```json
{
  "symbol": "AAPL",
  "timeframe": "1Day",
  "start": "2024-01-01T00:00:00Z",
  "end": "2024-02-01T00:00:00Z",
  "quantity": 10,
  "strategy": "sma-cross",
  "fast_period": 5,
  "slow_period": 20
}
```

Strategies:

- `buy-and-hold` (default)
- `sma-cross` (uses simple moving average crossover; configurable fast/slow periods)

### `POST /api/v1/orders/market`

Request body:

```json
{
  "symbol": "AAPL",
  "quantity": 1,
  "side": "buy",
  "time_in_force": "day",
  "extended_hours": false
}
```

Response mirrors Alpaca’s order payload.

## Deployment

- Argo CD manifests live in `argocd/applications/miel` and expect the image `registry.ide-newton.ts.net/lab/miel:<tag>`.
- Provide a `Secret` named `miel-secrets` in the `miel` namespace with keys `alpaca-api-key` and `alpaca-secret-key` before syncing.
- Optional non-secret overrides can be applied by editing `configmap.yaml` or layering a Kustomize overlay.

## Next Steps

- Extend the backtest engine with additional strategies (RSI, Bollinger Bands, etc.).
- Persist backtest runs (PostgreSQL or object storage) for later retrieval via the API.
- Export Prometheus metrics (latency, success/failure counts, strategy performance) for observability.
- Add validation of available buying power before placing live orders.
