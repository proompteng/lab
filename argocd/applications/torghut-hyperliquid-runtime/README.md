# Torghut Hyperliquid Execution

This app keeps the existing `torghut-hyperliquid-runtime` Kubernetes shell name, but runs the hard-reset v2
`app.hyperliquid_execution` implementation underneath it. It does not replace Alpaca, Torghut TA, options, or proof
systems.

V2 contract:

- Market data network is `mainnet`.
- Execution network is `testnet`.
- Runtime env names use `HYPERLIQUID_EXECUTION_*`; old `HYPERLIQUID_RUNTIME_*` names are rejected by config validation.
- ConfigMap-only runtime env changes must bump Deployment pod-template annotation `proompteng.ai/config-revision` so
  Argo creates a new ReplicaSet and the process reads the new env.
- The configured execution universe is
  `BTC,ETH,HYPE,SOL,xyz:SKHX,xyz:MU,xyz:XYZ100,xyz:CL,xyz:SNDK,xyz:MSTR,xyz:SILVER,xyz:GOLD`. Selection uses direct
  Hyperliquid mainnet `metaAndAssetCtxs` 24h notional volume (`dayNtlVlm`) and keeps only markets enabled in
  Hyperliquid testnet metadata. Crypto is intentionally limited to `BTC,ETH,HYPE,SOL`; the remaining slots are the
  highest-volume testnet-enabled TradFi/HIP-3 markets.
  `xyz:CRCL` is manually excluded. Higher-volume names like `xyz:SP500`, `ZEC`, `XRP`, `xyz:DRAM`, and `xyz:SPCX` are
  excluded when they are not enabled in the testnet execution metadata.
- `SPX` is excluded.
- Strategy entry uses one testnet IOC execution path: `ORDER_POLICY=marketable_ioc` and `ORDER_TTL_SECONDS=10`.
- Strategy entry requires edge to clear `max(MIN_EDGE_BPS=3, spread_bps + COST_BUFFER_BPS=2)`.
- Signal freshness allows the same `180s` source and quote-lag window used by runtime dependency readiness.
- Short entries are enabled in the restore lane with `HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES=true`; entries remain
  bounded by per-symbol Hyperliquid max leverage, account margin utilization, cooldown, and single-open-order controls.
- Margin budgets replace the old fixed notional caps: `TARGET_MARGIN_UTILIZATION=0.35`,
  `MAX_SYMBOL_MARGIN_UTILIZATION=0.08`, and `MAX_ORDER_MARGIN_UTILIZATION=0.02`.

Trading is enabled for margin-budgeted testnet execution with `HYPERLIQUID_EXECUTION_TRADING_ENABLED=true` after the v2 runtime
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
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/trading/loop/status`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/report`
- `kubectl -n torghut exec deploy/torghut-hyperliquid-runtime -- curl -fsS localhost:8182/metrics`
