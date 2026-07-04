# Torghut no-delta repair reentry auction rollout note

Governing design:

- `docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `docs/torghut/design-system/v6/207-torghut-quant-plan-closeout-and-alpha-repair-reentry-handoff-2026-05-14.md`

Runtime requirement:

- Source of truth: `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`
- Business metric: increase routeable post-cost profit evidence and live trading readiness without weakening capital
  safety.
- Selected value gate: `routeable_candidate_count`.

## Live evidence before implementation

Read-only sample at `2026-05-14T14:34:43Z`:

- `business_state=repair_only`
- `revenue_ready=false`
- active revision `torghut-00392`
- source commit `637239a49a577d20596ded51244d6fb3b0cf3d72`
- top queue item `repair_alpha_readiness`
- top queue reason `hypothesis_not_promotion_eligible`
- top queue value gate `routeable_candidate_count`
- `accepted_routeable_candidate_count=0`
- repair-bid settlement `routeable_candidate_count=0`
- `max_notional=0`
- `live_submission_allowed=false`
- `/trading/consumer-evidence` did not expose `no_delta_repair_reentry_auction`

Read-only sample after local implementation, before deploy, at `2026-05-14T14:49:40Z`:

- `business_state=repair_only`
- `revenue_ready=false`
- active revision `torghut-00393`
- source commit `637239a49a577d20596ded51244d6fb3b0cf3d72`
- top queue item `repair_alpha_readiness`
- top queue reason `hypothesis_not_promotion_eligible`
- top queue value gate `routeable_candidate_count`
- `accepted_routeable_candidate_count=0`
- repair-bid settlement `routeable_candidate_count=0`
- alpha repair dividend state `no_delta`
- active no-delta release key present
- `no_delta_repair_reentry_auction=null` on live service because this PR is not deployed yet
- `/readyz` returned HTTP 503 with expected capital-safety holds: `simple_submit_disabled` and `repair_only`

## What changed

This implementation adds `torghut.no-delta-repair-reentry-auction.v1` in observe mode.

- The auction denies duplicate alpha-readiness reentry when the active no-delta release key is unchanged.
- It selects at most one zero-notional ticket when a release condition changes.
- It can select Jangar verify-carry as a release condition when a current foreclosure ticket exists.
- It exports the full auction on `/trading/revenue-repair`.
- It mirrors compact `torghut.no-delta-repair-reentry-auction-ref.v1` through `/readyz` and
  `/trading/consumer-evidence`.
- It preserves `max_notional=0`, `capital_rule=zero_notional_repair_only`, and disabled paper/live submission.

## Validation

Local validation used `/tmp/codex-uv-bootstrap/bin/uv` because `uv` was not installed on PATH in this workspace.

- `/tmp/codex-uv-bootstrap/bin/uv sync --frozen --extra dev`: pass
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen ruff format --check app/trading/no_delta_repair_reentry_auction.py app/trading/revenue_repair.py app/main.py tests/test_no_delta_repair_reentry_auction.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`: pass
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen ruff check app/trading/no_delta_repair_reentry_auction.py app/trading/revenue_repair.py app/main.py tests/test_no_delta_repair_reentry_auction.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`: pass
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py`: pass, 13 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_alpha_readiness_settlement_conveyor.py`: pass, 7 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_alpha_repair_dividend_ledger.py`: pass, 10 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair`: pass, 15 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_trading_api.py -k "consumer_evidence or revenue_repair"`: pass, 2 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_consumer_evidence.py`: pass, 2 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py tests/test_alpha_readiness_settlement_conveyor.py tests/test_alpha_repair_dividend_ledger.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py tests/test_consumer_evidence.py -k "no_delta or alpha or revenue_repair or consumer_evidence" --cov --cov-branch --cov-fail-under=0 --cov-report=xml --cov-report=`: pass, 50 tests
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90`: pass, changed-line coverage 99.65%
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pyright --project pyrightconfig.json`: pass
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pyright --project pyrightconfig.alpha.json`: pass
- `/tmp/codex-uv-bootstrap/bin/uv run --frozen pyright --project pyrightconfig.scripts.json`: pass

Note: the design-doc command `pytest tests/test_consumer_evidence.py -k alpha` selected zero tests in this repo state,
so the whole `tests/test_consumer_evidence.py` file was run instead.

## Risk and rollback

Risk is limited to an additive observe-mode payload and compact reference. The reducer does not mutate database state,
broker state, Kubernetes resources, trading flags, or GitOps resources.

Rollback is to revert the PR or stop emitting `no_delta_repair_reentry_auction`, leaving the existing alpha-readiness
settlement conveyor, alpha repair dividend ledger, repair-bid settlement, and capital proof-floor contracts as the
authorities. Paper and live action classes remain closed because `max_notional=0` and live submit stays disabled.

## Revenue impact

The metric targeted is `routeable_candidate_count`. Immediate live revenue impact is still blocked because
`repair_alpha_readiness` remains the top queue item, selected `H-MICRO-01` has no routeable-candidate delta, and the
live service has not yet deployed this PR. The implementation improves readiness by making duplicate no-delta reentry
machine-deniable and by naming the single zero-notional release-condition ticket that can be admitted after rollout.
