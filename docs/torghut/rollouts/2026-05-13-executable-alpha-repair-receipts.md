# 2026-05-13 Torghut Executable Alpha Repair Receipts

## Scope

This rollout note covers the compact zero-notional executable-alpha repair receipt projection for the Torghut quant
repair loop.

Governing design references:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md`
- `docs/torghut/design-system/v6/197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`
- `docs/torghut/design-system/v6/197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`

## Runtime Evidence Before Change

Read-only source: `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` on 2026-05-13.

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- selected value gate: `routeable_candidate_count`
- `routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- capital remained `zero_notional` with `max_notional=0`
- live submission remained disabled by `simple_submit_disabled`

The endpoint already selected the right business blocker, but the alpha-readiness work item was still spread across
the queue row, capital replay board, executable-alpha candidate receipts, and nested alpha target evidence. Jangar
needed a compact repair receipt that names the target, repair class, expected blocker delta, validation command, and
no-delta settlement requirement without widening capital.

## Shipped Change

- `services/torghut/app/trading/executable_alpha_receipts.py` now builds
  `torghut.executable-alpha-repair-receipts.v1` collections and selected
  `torghut.executable-alpha-repair-receipt.v1` receipts when the top revenue-repair queue item is
  `repair_alpha_readiness`.
- The builder maps current alpha blockers to repair classes: strategy lineage repair, evidence-window refresh,
  autoresearch portfolio repair, equity TA refill, rejection drag measurement, promotion decision receipt, and capital
  replay board refresh.
- Each receipt carries `max_notional=0`, `capital_rule=zero_notional_repair_only`, required input refs, required output
  receipts, validation commands, Jangar material-reentry binding, and `no_delta_settlement_required=true`.
- `/trading/revenue-repair` exposes the compact collection as `executable_alpha_repair_receipts`.
- `/trading/consumer-evidence` mirrors the same compact collection for Jangar while keeping readiness and capital gates
  unchanged.

## Validation

Initial targeted validation:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pytest tests/test_executable_alpha_repair_receipts.py tests/test_build_revenue_repair_digest.py -k "executable_alpha or repair_only_payload"
```

Result: `5 passed`, `13 deselected`, with the existing event-loop deprecation warning from `tests/conftest.py`.

Broader local validation:

- `uv lock --check`: pass
- `uv run --frozen ruff format --check app/trading/executable_alpha_receipts.py app/trading/revenue_repair.py app/main.py tests/test_executable_alpha_repair_receipts.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`: pass
- `uv run --frozen ruff check app tests scripts migrations`: pass
- `uv run --frozen python scripts/check_migration_graph.py`: pass
- `uv run --frozen python -m compileall app`: pass
- `uv run --frozen pyright --project pyrightconfig.json`: pass
- `uv run --frozen pyright --project pyrightconfig.alpha.json`: pass
- `uv run --frozen pyright --project pyrightconfig.scripts.json`: pass
- `uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml`: pass, `2275 passed`,
  total coverage `79.02%`

## Risk And Rollback

Risk is limited to additive evidence payload fields on `/trading/revenue-repair` and `/trading/consumer-evidence`.
The change does not alter submission gates, notional sizing, repair execution, database state, broker state, or
GitOps manifests. Roll back by reverting the PR or suppressing the `executable_alpha_repair_receipts` projection;
existing revenue-repair queue, strike ledger, repair-bid settlement, and capital holds remain intact.

## Owner-Facing Status

This improves `routeable_candidate_count` readiness by turning the current top alpha-readiness queue item into a
compact zero-notional repair receipt with explicit no-delta accounting. It does not make Torghut revenue-ready by
itself: live submission remains disabled until alpha readiness, proof-floor, routeability, TCA, and capital gates pass.
