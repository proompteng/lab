# Torghut Hyperliquid Execution

This app keeps the existing `torghut-hyperliquid-runtime` Kubernetes shell name, but runs the hard-reset v2
`app.hyperliquid_execution` implementation underneath it. It does not replace Alpaca, Torghut TA, options, or proof
systems.

V2 contract:

- Market data network is `mainnet`.
- Execution network is `testnet`.
- Runtime env names use `HYPERLIQUID_EXECUTION_*`; old `HYPERLIQUID_RUNTIME_*` names are rejected by config validation.
- The configured execution universe is
  `xyz:NVDA,xyz:AMD,xyz:AVGO,xyz:MRVL,xyz:INTC,xyz:MU,xyz:WDC,xyz:SNDK,xyz:ARM,xyz:LITE`.
- `SPX` is excluded.
- Strategy entry is maker-first only: `ORDER_POLICY=maker_ttl`, `MAKER_TIF=Alo`, and `MAKER_TTL_SECONDS=45`.
- Short entries are disabled in the proving lane with `HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES=false`.
- Caps are intentionally small: `$10` max order notional, `$25` max symbol exposure, and `$100` max gross exposure.
- `sample_ready=false` until at least 40 v2 fills exist.

Trading is enabled for capped testnet execution with `HYPERLIQUID_EXECUTION_TRADING_ENABLED=true` after the v2 runtime
passed `/readyz`, `/report`, DB migration, and account checks. Keep execution on testnet unless a separate mainnet
execution plan is explicitly approved.

To authorize execution, create and authorize a Hyperliquid testnet API/agent wallet for the dedicated testnet account.
Store the main account address and authorized API wallet private key in the 1Password item `hyperliquid-testnet` in the
`infra` vault with fields:

- `account-address`
- `api-wallet-private-key`

Use the repo bootstrap helper after authorizing the 1Password CLI prompt:

```bash
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh status
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh check
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh create
scripts/torghut/bootstrap-hyperliquid-testnet-1password.sh reconcile
```

Acceptance checks:

- `kubectl -n argocd get application torghut-hyperliquid-runtime`
- `kubectl -n torghut rollout status deploy/torghut-hyperliquid-runtime --timeout=180s`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/readyz`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/report`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/metrics`
