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
- reason `hypothesis_not_promotion_eligible`
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
- Rebasing onto current `main` pulled in the 16-slice autoresearch CI workflow; raised that job timeout from 10 to 15
  minutes after slice 9 passed all tests in 573.96s but was canceled before coverage artifact upload.

## Business Evidence

Before implementation, live Torghut returned:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item `repair_alpha_readiness`
- value gate `routeable_candidate_count`
- `max_notional=0`
- `/trading/consumer-evidence` did not expose `alpha_closure_dividend_slo`

After local validation, live Torghut is still pre-deploy and unchanged. Sample from
`/trading/revenue-repair` at `2026-05-14T22:06:23.559628+00:00`:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item `repair_alpha_readiness`
- reason `hypothesis_not_promotion_eligible`
- value gate `routeable_candidate_count`
- `capital.live_submission_allowed=false`
- `routeability_acceptance.accepted_routeable_candidate_count=0`
- `routeability_acceptance.zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- `/trading/consumer-evidence` still reports `alpha_closure_dividend_slo` absent until this PR is deployed

Expected post-deploy evidence is that `/trading/consumer-evidence.alpha_closure_dividend_slo` exists, reports
`dividend_state=no_delta` or `pending` for the active alpha closure, keeps `max_notional=0`, and gives Jangar a compact
hold reason for duplicate no-delta dispatch.

## Validation

- `uv sync --frozen --extra dev`
- `uv lock --check`
- `uv run --frozen pytest --cov --cov-branch --cov-fail-under=0 --cov-report=xml:coverage.xml tests/test_alpha_closure_dividend_slo.py tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k 'alpha_closure_dividend_slo or alpha or revenue_repair or consumer_evidence or trading_consumer_evidence_avoids_recursive_jangar_status_fetch'`
- `uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90 --base-ref origin/main`
- `uv run --frozen python -m compileall app`
- `uv run --frozen ruff check app tests scripts migrations`
- `uv run --frozen ruff format --check app/trading/alpha_closure_dividend_slo.py app/main.py tests/test_alpha_closure_dividend_slo.py tests/test_trading_api.py`
- `uv run --frozen python scripts/check_migration_graph.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-material-gate-digest.test.ts`
- `bunx oxfmt --check src/server/control-plane-status-types.ts src/server/control-plane-torghut-alpha-closure-dividend-slo.ts src/server/control-plane-torghut-consumer-evidence.ts src/server/control-plane-material-gate-digest.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-material-gate-digest.test.ts`
- `bunx oxlint --config ../../.oxlintrc.json src/server/control-plane-status-types.ts src/server/control-plane-torghut-alpha-closure-dividend-slo.ts src/server/control-plane-torghut-consumer-evidence.ts src/server/control-plane-material-gate-digest.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-material-gate-digest.test.ts`
- `bunx tsc --noEmit --project tsconfig.paths.json`
- `bun run --cwd services/jangar docs:inventory:check`
- `bunx oxfmt --check docs/jangar/architecture-inventory.md docs/torghut/rollouts/2026-05-14-alpha-closure-dividend-slo.md`
- `uv run --frozen python -c 'from pathlib import Path; import yaml; yaml.safe_load(Path("../../.github/workflows/torghut-ci.yml").read_text()); print("torghut-ci.yml parses")'`
- `git diff --check`
- CI evidence from PR #6687: `Pytest autoresearch runner 9` passed 5 tests in 573.96s, then the 10-minute job window
  canceled before upload; the workflow timeout is now 15 minutes.

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
