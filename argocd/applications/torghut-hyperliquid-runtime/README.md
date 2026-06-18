# Torghut Hyperliquid Runtime

This app runs the isolated Hyperliquid testnet trading lane. It does not replace the existing Torghut or Alpaca services.

V1 defaults to shadow mode:

- Public market and signal state comes from ClickHouse Hyperliquid feed tables.
- Operational state is written to the Hyperliquid-specific Postgres tables from migration `0054`.
- TigerBeetle transfer refs are planned deterministically for submitted holds, fills, fees, realized PnL, and releases.
- Mainnet execution is blocked in config validation and code.
- When trading is enabled, the runtime filters the selected mainnet market-data universe through Hyperliquid testnet
  perp metadata before any feature can produce an order. If testnet metadata is stale, unavailable, or has no matching
  equity-like markets, readiness fails and no orders are submitted.

To enable tiny testnet orders, create and authorize a Hyperliquid testnet API/agent wallet for the dedicated testnet account. Store the main account address and authorized API wallet private key in the 1Password item `hyperliquid-testnet` in the `infra` vault with fields:

- `account-address`
- `api-wallet-private-key`

Use the repo bootstrap helper after signing in to 1Password CLI:

```bash
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh status
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh check
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh create
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh reconcile
```

`status` is safe to run repeatedly. It reports only whether the 1Password item, required fields, ExternalSecret,
and target Kubernetes Secret exist; it does not print credential values.

Shadow mode does not require Hyperliquid execution credentials, but this app now includes the ExternalSecret because
`op://infra/hyperliquid-testnet` exists with the required fields. Keep `HYPERLIQUID_RUNTIME_TRADING_ENABLED=false`
until `reconcile` reports the Kubernetes Secret as ready and the exchange-side testnet account is funded or authorized.

After `check` reports the 1Password item is present, keep `externalsecret.yaml` in `kustomization.yaml` while
`HYPERLIQUID_RUNTIME_TRADING_ENABLED=false`. Merge and wait for Argo to sync, then run
`scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh reconcile`. After `reconcile` reports the Kubernetes Secret
as ready, open the trading-enable PR that sets `HYPERLIQUID_RUNTIME_TRADING_ENABLED=true` in `configmap.yaml`.
Keep the default caps unless a separate rollout approves a larger envelope. The runtime must continue to report
`execution_network=testnet`; mainnet execution is rejected by config validation.

Acceptance checks:

- `kubectl -n argocd get application torghut-hyperliquid-runtime`
- `kubectl -n torghut rollout status deploy/torghut-hyperliquid-runtime --timeout=180s`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/readyz`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/metrics`
