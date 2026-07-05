# Torghut Profitability Recovery Execution Record

## Goal

Stop the July 5 Hyperliquid testnet fee-burning loop, repair fill accounting, remove stale non-operational submission blockers, and keep normal entries disabled unless a single after-cost, position-aware execution path proves the trade is operationally valid.

## Incident Evidence

- Testnet account value fell from `1013.237967` at `2026-07-05T03:26:33Z` to `541.720310` at `2026-07-05T18:11:16Z`.
- Direct Hyperliquid API since midnight showed `1374` fills, `$271465.784240` notional, `-325.939657` closed PnL, `121.717138` fees, and `-447.656795` net after fees.
- BTC alone showed `717` fills, `$231690.542950` notional, `-45.976740` closed PnL, `104.260382` fees, and `-150.237122` net after fees.
- Hyperliquid returned `1374` unique `tid` values but only `479` unique `hash` values. The runtime used `hash` before `tid`, so DB fill rows undercounted realized churn.
- The previous Hyperliquid path persisted expected return and expected cost as diagnostics, then still submitted marketable IOC entries.

## 20 Whys With Answers

1. Why did the account lose money? Because marketable IOC entries repeatedly crossed costs with negative after-fee expectancy.
2. Why was BTC especially bad? BTC generated about `$231.7k` notional for a roughly `$1k` account and paid about `$104.26` in fees.
3. Why did BTC churn so much? The loop could submit every cycle when a tiny directional score was non-zero.
4. Why were tiny scores enough? `generate_signal()` converts any non-zero expected return into a direction.
5. Why did costs not stop it? Portfolio construction stored `expected_cost_bps` but did not require edge to exceed cost.
6. Why were orders so expensive? `marketable_ioc` plus large slippage made entries aggressively executable.
7. Why was that unsafe? Small short-horizon alpha cannot overcome taker fees, spread, impact, and adverse selection at that turnover.
8. Why was the damage understated in DB reports? Fill identity used non-unique order `hash` before unique trade `tid`.
9. Why did rows disappear? `ON CONFLICT (execution_network, fill_hash) DO NOTHING` discarded fills sharing a hash.
10. Why did risk allow the loop before daily loss stop? Risk checked exposure and daily PnL but not rolling symbol PnL, turnover, or after-cost edge.
11. Why did flips hurt? The path could reverse direction from small sign changes instead of flattening first.
12. Why was position state insufficient? There was no signed-position rule requiring reduce-only before opposite entries.
13. Why did old blockers not help? Alpha/runtime-ledger/promotion blockers were non-operational and did not encode execution quality.
14. Why did removing those blockers not create profitability? It restored order flow without replacing it with a cost/profit gate.
15. Why is "trading" not success? Fills without positive net expectancy are just automated loss generation.
16. Why must testnet be treated seriously? It is the proving surface before live capital; losing testnet exposes unsafe execution design.
17. Why should new entries be frozen now? The live 24h evidence is negative and the daily loss stop would otherwise reset.
18. Why not simply lower size? Smaller losing trades still lose if edge is below cost; the gate must be expectancy-first.
19. Why is a generic diagnostic filter still needed? Old upstream status payloads may contain non-operational reasons, but submission authority must only honor concrete operational blockers.
20. Why is this the correct fix? It turns the path from submit-first to proof-first: reconcile, check position/risk/profitability, reduce risk, then submit at most one normal entry.

## Implemented Changes

- `argocd/applications/torghut-hyperliquid-runtime/configmap.yaml` now sets `HYPERLIQUID_EXECUTION_TRADING_ENABLED=false` and configures after-cost, edge/cost, turnover, entry cooldown, and side-flip gates.
- Runtime image promotion remains release-owned: this source PR must merge first, then the Torghut release PR must update `TORGHUT_COMMIT`, `TORGHUT_IMAGE_DIGEST`, and the Hyperliquid runtime image digest before the new code is live.
- `services/torghut/app/hyperliquid_execution/exchange.py` now prefers Hyperliquid `tid` over `hash` for fill identity.
- `services/torghut/app/hyperliquid_execution/repository.py` deduplicates legacy hash-keyed fills before inserting the canonical `tid` fill so PnL/turnover do not double-count after rollout.
- `services/torghut/app/hyperliquid_execution/profitability.py` adds the hard after-cost profitability gate.
- `services/torghut/app/hyperliquid_execution/repository.py` exposes rolling symbol PnL, 1h turnover, last-side state, and current signed position.
- `services/torghut/app/hyperliquid_execution/service.py` now blocks normal entries before `build_order_intent()` unless risk and profitability both pass. Opposite positions are closed reduce-only only after the new signal passes profitability, and still cannot flip into a new entry in the same cycle.
- `/trading/status` and `/report` expose `profitability_gate`.
- `services/torghut/app/trading/submission_authority.py` and `services/torghut/app/trading/execution_runtime.py` now keep only known operational blockers/reject reasons instead of hardcoding old alpha/runtime-ledger diagnostic blockers.

## Validation

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest tests/hyperliquid_execution tests/test_submission_authority.py tests/test_execution_runtime.py tests/api/test_trading_api_simple_lane_profit_floor.py -q`
- `uv run --frozen ruff check app/hyperliquid_execution app/trading/submission_authority.py app/trading/execution_runtime.py tests/hyperliquid_execution tests/test_submission_authority.py tests/test_execution_runtime.py tests/api/test_trading_api_simple_lane_profit_floor.py`
- `uv run --frozen ruff format --check app/hyperliquid_execution app/trading/submission_authority.py app/trading/execution_runtime.py tests/hyperliquid_execution tests/test_submission_authority.py tests/test_execution_runtime.py tests/api/test_trading_api_simple_lane_profit_floor.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `bun run lint:argocd`

## Re-Enable Criteria

Normal entries stay disabled until all are true:

- Fill reconciliation uses unique `tid` and recent API-vs-DB fill count mismatch is zero.
- Rolling symbol net PnL after fees is non-negative.
- Expected edge exceeds expected cost by at least `4 bps` and `2x`.
- No liquidations or auto-deleveraging events exist in the recent execution window.
- 1h symbol turnover is below `1x` account value.
- Direct side flips reduce-only first and respect the configured flip cooldown.
- `/report`, `/trading/status`, and live fills/positions agree on gate state and realized performance.
