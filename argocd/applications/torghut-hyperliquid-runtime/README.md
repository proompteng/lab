# Torghut Hyperliquid Runtime

This app runs the isolated Hyperliquid testnet trading lane. It does not replace the existing Torghut or Alpaca services.

V1 defaults to shadow mode:

- Public market and signal state comes from ClickHouse Hyperliquid feed tables.
- Operational state is written to the Hyperliquid-specific Postgres tables from migration `0054`.
- TigerBeetle transfer refs are planned deterministically for submitted holds, fills, fees, realized PnL, and releases.
- Mainnet execution is blocked in config validation and code.

To enable tiny testnet orders, create the 1Password item `hyperliquid-testnet` in the `infra` vault with fields:

- `account-address`
- `api-wallet-private-key`

Then set `HYPERLIQUID_RUNTIME_TRADING_ENABLED` to `true` in `configmap.yaml`. Keep the default caps unless a separate rollout approves a larger envelope.

Acceptance checks:

- `kubectl -n argocd get application torghut-hyperliquid-runtime`
- `kubectl -n torghut rollout status deploy/torghut-hyperliquid-runtime --timeout=180s`
- `kubectl -n torghut get externalsecret torghut-hyperliquid-testnet`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/readyz`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/metrics`
