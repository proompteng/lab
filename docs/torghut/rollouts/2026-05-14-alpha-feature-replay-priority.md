# Torghut Alpha Feature Replay Priority

Date: 2026-05-14

Governing design:

- `docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
- `docs/torghut/design-system/v6/200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`

Runtime requirement source:

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`

Before evidence at `2026-05-14T04:07:00Z`:

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `accepted_routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- live closure market selected `H-MICRO-01` / `feature_replay_closure`
- live profit-freshness frontier selected `rerun_drift_checks_for_blocked_hypotheses`

## Change

The profit-freshness frontier now applies a bounded `alpha_feature_replay_closure` priority adjustment to
`feature_coverage` repair lots when `feature_rows_missing` or `required_feature_set_unavailable` are present. That
aligns the default zero-notional repair action with the alpha closure settlement market, which reserves the active
H-MICRO-01 slot for feature replay while `repair_alpha_readiness` remains the top revenue blocker.

This is an additive ranking change only. It does not make `/readyz` green, does not change repair queue order, does
not submit orders, and does not open paper or live notional.

## Validation

Run before release handoff:

- `cd services/torghut && uv run --frozen pytest tests/test_profit_freshness_frontier.py -k feature_replay_closure`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k zero_notional_repair`
- `cd services/torghut && uv run --frozen ruff format --check app/trading/profit_freshness_frontier.py tests/test_profit_freshness_frontier.py`
- `cd services/torghut && uv run --frozen ruff check app/trading/profit_freshness_frontier.py tests/test_profit_freshness_frontier.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`

## Risk And Rollback

Risk is limited to ranking between existing zero-notional repair lots. Feature replay can still fail closed through the
existing repair endpoint if no signals, feature runner, or quality pass is available. Rollback is to revert the priority
adjustment; Torghut remains `max_notional=0` with live submission disabled either way.

## Revenue Status

This targets `routeable_candidate_count` by making the selected H-MICRO-01 closure run feature evidence repair before
lower-value drift-only repair. Immediate revenue impact remains blocked until feature rows, required feature-set
availability, drift checks, post-cost proof, route TCA, and capital gates settle with routeable candidates above zero.
