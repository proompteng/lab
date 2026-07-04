# 2026-05-13 Torghut Alpha Readiness Repair Targets

## Scope

This rollout note covers the zero-notional alpha-readiness repair target projection added for the Torghut quant repair
loop.

Governing design references:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md`
- `docs/torghut/design-system/v6/168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`
- `docs/torghut/design-system/v6/192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md`

## Runtime Evidence Before Change

Read-only source: `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` on 2026-05-13.

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- selected value gate: `routeable_candidate_count`
- capital remained `zero_notional` with `max_notional=0`
- routeable candidate count remained `0`

The live routeability acceptance lot for `alpha_readiness_repair` showed empty `symbols` and `hypothesis_ids`, even
though the route-evidence clearinghouse had hypothesis and candidate refs. That made the top repair action measurable
only as a generic blocker, not as a scoped hypothesis repair.

## Shipped Change

- The profitability proof floor now projects alpha repair target provenance from hypothesis runtime items into the
  `alpha_readiness` source ref: hypothesis ids, blocked ids, promotion-eligible ids, repair target counts, and compact
  target metadata.
- Route reacquisition records already consume proof-floor alpha `hypothesis_ids`; with the new source refs, zero-notional
  route repair rows can name the hypothesis that must clear before routeability can count a candidate.
- `/trading/revenue-repair` now preserves those alpha repair targets in `evidence.alpha_readiness`, so Jangar and
  operators can dispatch `repair_alpha_readiness` against a concrete target while keeping capital closed.

## Validation

Local targeted validation:

```bash
cd services/torghut
/root/.local/bin/uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_build_revenue_repair_digest.py tests/test_route_reacquisition.py tests/test_routeability_repair_acceptance.py
```

Result: `47 passed`.

Broader local validation:

- `/root/.local/bin/uv lock --check`: pass
- `/root/.local/bin/uv run --frozen ruff format --check app/trading/proof_floor.py app/trading/revenue_repair.py tests/test_profitability_proof_floor.py tests/test_build_revenue_repair_digest.py`: pass
- `/root/.local/bin/uv run --frozen ruff check app tests scripts migrations`: pass
- `/root/.local/bin/uv run --frozen python -m compileall app`: pass
- `/root/.local/bin/uv run --frozen python scripts/check_migration_graph.py`: pass
- `/root/.local/bin/uv run --frozen pyright --project pyrightconfig.json`: pass
- `/root/.local/bin/uv run --frozen pyright --project pyrightconfig.alpha.json`: pass
- `/root/.local/bin/uv run --frozen pyright --project pyrightconfig.scripts.json`: pass
- `/root/.local/bin/uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml`: pass,
  `2256 passed`, total coverage `78.91%`

## Risk And Rollback

Risk is limited to additive evidence payload fields. The change does not alter submission gates, notional sizing,
route-state decisions, or live submit configuration. If a downstream consumer rejects the added fields, roll back by
reverting this PR; the prior behavior falls back to generic `hypothesis_not_promotion_eligible` repair evidence
with capital still held at `max_notional=0`.

## Owner-Facing Status

This improves `routeable_candidate_count` readiness by making the current top alpha repair target concrete. It does
not make Torghut revenue-ready by itself: live submission remains disabled until the repair queue clears and proof-floor
capital gates leave `repair_only`.
