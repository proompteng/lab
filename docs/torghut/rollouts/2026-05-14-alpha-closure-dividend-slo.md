# Torghut Alpha Closure Dividend SLO

Date: 2026-05-14

Governing design:

- `docs/torghut/design-system/v6/203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md`

Runtime requirement source:

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`

## Selected Runtime Item

Live revenue-repair selected the top actionable item:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item `repair_alpha_readiness`
- reason `alpha_readiness_not_promotion_eligible`
- value gate `routeable_candidate_count`
- `max_notional=0`
- `no_delta_repair_reentry_auction.reentry_decision=deny`

The selected repair maps to the swarm objective by improving routeable-candidate custody evidence while preserving
capital safety. This change does not enable live submission, paper canary, or any nonzero notional path.

## Change

- Added `torghut.alpha-closure-dividend-slo.v1` as a compact consumer-evidence object derived from the current alpha
  closure board and alpha repair dividend ledger.
- Exposed `alpha_closure_dividend_slo` on Torghut `/trading/consumer-evidence` and `/readyz` health payloads.
- Updated Jangar consumer-evidence ingestion to parse the SLO and include it in observed contracts.
- Updated Jangar material-gate digest to prefer the SLO for alpha closure carry decisions, with fallback to the
  existing alpha repair closure board.

## Business Evidence

Before implementation, live Torghut returned:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item `repair_alpha_readiness`
- value gate `routeable_candidate_count`
- `max_notional=0`
- `/trading/consumer-evidence` did not expose `alpha_closure_dividend_slo`

After local validation, live Torghut is still pre-deploy and unchanged:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item `repair_alpha_readiness`
- value gate `routeable_candidate_count`
- `max_notional=0`
- `/trading/consumer-evidence` still reports `alpha_closure_dividend_slo` absent until this PR is deployed

Expected post-deploy evidence is that `/trading/consumer-evidence.alpha_closure_dividend_slo` exists, reports
`dividend_state=no_delta` or `pending` for the active alpha closure, keeps `max_notional=0`, and gives Jangar a compact
hold reason for duplicate no-delta dispatch.

## Validation

- `uv run --frozen pytest tests/test_alpha_closure_dividend_slo.py tests/test_trading_api.py -k 'alpha_closure_dividend_slo or trading_consumer_evidence_avoids_recursive_jangar_status_fetch'`
- `uv run --frozen pytest tests/test_alpha_closure_dividend_slo.py tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k 'alpha_closure_dividend_slo or alpha or revenue_repair or consumer_evidence'`
- `uv run --frozen ruff format --check app/trading/alpha_closure_dividend_slo.py app/main.py tests/test_alpha_closure_dividend_slo.py tests/test_trading_api.py`
- `uv run --frozen ruff check app/trading/alpha_closure_dividend_slo.py app/main.py tests/test_alpha_closure_dividend_slo.py tests/test_trading_api.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-material-gate-digest.test.ts`
- `bunx oxfmt --check src/data/agents-control-plane.ts src/server/control-plane-torghut-alpha-closure-dividend-slo.ts src/server/control-plane-torghut-consumer-evidence.ts src/server/control-plane-material-gate-digest.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-material-gate-digest.test.ts`
- `bunx oxlint --config ../../.oxlintrc.json src/data/agents-control-plane.ts src/server/control-plane-torghut-alpha-closure-dividend-slo.ts src/server/control-plane-torghut-consumer-evidence.ts src/server/control-plane-material-gate-digest.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-material-gate-digest.test.ts`
- `bunx tsc --noEmit -p tsconfig.app.json`
- `bun run --cwd services/jangar docs:inventory:check`
- `bunx oxfmt --check docs/jangar/architecture-inventory.md`

## Risk And Rollback

Risk is limited to additive evidence fields and Jangar custody interpretation. The SLO is observe-mode, fails closed on
missing refs, stale data, invalid notional, or non-zero capital rule, and keeps existing alpha repair closure board
fallbacks.

Rollback is to revert the PR or stop emitting `alpha_closure_dividend_slo`; Jangar will fall back to the existing
`alpha_repair_closure_board` carry. Torghut remains `repair_only` with `max_notional=0`.

## Owner Status

The revenue metric targeted is `routeable_candidate_count`. This PR improves readiness and handoff evidence for the
current alpha-readiness no-delta blocker. Revenue impact remains blocked until the active alpha closure produces a
positive routeable-candidate delta or retires the selected alpha blocker under zero notional.
