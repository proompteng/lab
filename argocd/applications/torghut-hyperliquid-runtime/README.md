# Torghut Hyperliquid Runtime

This app runs the isolated Hyperliquid testnet trading lane. It does not replace the existing Torghut or Alpaca services.

V1 runs as a testnet-only trading lane:

- Public market and signal state comes from ClickHouse Hyperliquid feed tables.
- Operational state is written to the Hyperliquid-specific Postgres tables from migration `0054`.
- TigerBeetle transfer refs are planned deterministically for submitted holds, fills, fees, realized PnL, and releases.
- Mainnet execution is blocked in config validation and code.
- Tiny testnet orders are enabled after the ExternalSecret is ready and the dedicated Hyperliquid testnet account is
  funded. Keep the default risk caps unless a separate rollout approves a larger envelope.
- When trading is enabled, the runtime filters the selected mainnet market-data universe through Hyperliquid testnet
  perp metadata before any feature can produce an order. Crypto perps are eligible for the 24/7 lane. Equity-like
  stocks, indices, and pre-IPO perps are locally blocked outside the U.S. cash session so halted venues do not receive
  exchange orders.

To enable tiny testnet orders, create and authorize a Hyperliquid testnet API/agent wallet for the dedicated testnet account. Store the main account address and authorized API wallet private key in the 1Password item `hyperliquid-testnet` in the `infra` vault with fields:

- `account-address`
- `api-wallet-private-key`

Use the repo bootstrap helper after authorizing the 1Password CLI prompt:

```bash
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh status
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh check
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh create
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh reconcile
```

`status` is safe to run repeatedly. It reports only whether the 1Password item, required fields, ExternalSecret,
and target Kubernetes Secret exist; it does not print credential values.

This app includes the ExternalSecret because `op://infra/hyperliquid-testnet` exists with the required fields.
Before enabling trading, `reconcile` must report the Kubernetes Secret as ready and the exchange-side testnet account
must be funded or authorized. Trading is intentionally frozen with `HYPERLIQUID_RUNTIME_TRADING_ENABLED=false` and
`replicas=0` while the hard-reset migration replaces the v1 runtime. The runtime must continue to report
`execution_network=testnet` when it is restored, and mainnet execution is rejected by config validation.

Acceptance checks:

- `kubectl -n argocd get application torghut-hyperliquid-runtime`
- `kubectl -n torghut rollout status deploy/torghut-hyperliquid-runtime --timeout=180s`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/readyz`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/metrics`
