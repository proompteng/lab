from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_ledger.support import *


def test_runtime_ledger_defensively_blocks_usable_non_promotion_grade_cost_basis() -> (
    None
):
    rows = [
        _NormalizedFill(
            row_index=0,
            executed_at=_ts(1),
            account_label="paper",
            strategy_id="strategy-1",
            symbol="NVDA",
            side="buy",
            filled_qty=Decimal("10"),
            avg_fill_price=Decimal("100"),
            filled_notional=Decimal("1000"),
            cost_amount=Decimal("1"),
            cost_basis="modeled_paper_cost_budget",
            event_type="fill",
            decision_id="decision-buy",
            order_id="order-buy",
            execution_policy_hash="policy-sha",
            cost_model_hash="cost-sha",
            lineage_hash="lineage-sha",
            replay_data_hash=None,
            blockers=(),
        ),
        _NormalizedFill(
            row_index=1,
            executed_at=_ts(12),
            account_label="paper",
            strategy_id="strategy-1",
            symbol="NVDA",
            side="sell",
            filled_qty=Decimal("10"),
            avg_fill_price=Decimal("110"),
            filled_notional=Decimal("1100"),
            cost_amount=Decimal("2"),
            cost_basis="modeled_paper_cost_budget",
            event_type="fill",
            decision_id="decision-sell",
            order_id="order-sell",
            execution_policy_hash="policy-sha",
            cost_model_hash="cost-sha",
            lineage_hash="lineage-sha",
            replay_data_hash=None,
            blockers=(),
        ),
    ]

    bucket = _build_bucket(bucket_start=_ts(), bucket_end=_ts(60), rows=rows)

    assert bucket.fill_count == 2
    assert bucket.cost_basis_counts == {"modeled_paper_cost_budget": 2}
    assert "runtime_ledger_cost_basis_non_promotion_grade" in bucket.blockers
    assert bucket.post_cost_expectancy_bps is None
    assert bucket.diagnostic_closed_trade_expectancy_bps is None


def test_exact_replay_ledger_blocks_fill_only_profit_proof() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            RuntimeLedgerFill(
                executed_at=_ts(1),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("1"),
                cost_basis="broker_reported_commission_and_fees",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(12),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="sell",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("110"),
                cost_amount=Decimal("2"),
                cost_basis="broker_reported_commission_and_fees",
            ),
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.net_strategy_pnl_after_costs == Decimal("97")
    assert bucket.post_cost_expectancy_bps is None
    _assert_decimal_close(
        bucket.diagnostic_closed_trade_expectancy_bps,
        (Decimal("97") / Decimal("2100")) * Decimal("10000"),
    )
    assert "runtime_decision_lifecycle_missing" in bucket.blockers
    assert "submitted_order_lifecycle_missing" in bucket.blockers
    assert "fill_order_linkage_missing" in bucket.blockers


def test_exact_replay_ledger_accepts_multiple_partial_fills_for_one_order() -> None:
    rows: list[dict[str, object]] = [
        {
            "event_type": "decision",
            "executed_at": _ts(1),
            "decision_id": "decision-buy",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(2),
            "decision_id": "decision-buy",
            "order_id": "order-buy",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
        {
            "event_type": "partial_fill",
            "executed_at": _ts(3),
            "decision_id": "decision-buy",
            "order_id": "order-buy",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "side": "buy",
            "filled_qty": Decimal("0.4"),
            "avg_fill_price": Decimal("100"),
            "cost_amount": Decimal("0.01"),
            "cost_basis": "broker_reported_commission_and_fees",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
        {
            "event_type": "fill",
            "executed_at": _ts(4),
            "decision_id": "decision-buy",
            "order_id": "order-buy",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "side": "buy",
            "filled_qty": Decimal("0.6"),
            "avg_fill_price": Decimal("100"),
            "cost_amount": Decimal("0.01"),
            "cost_basis": "broker_reported_commission_and_fees",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
        {
            "event_type": "decision",
            "executed_at": _ts(10),
            "decision_id": "decision-sell",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(11),
            "decision_id": "decision-sell",
            "order_id": "order-sell",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
        {
            "event_type": "fill",
            "executed_at": _ts(12),
            "decision_id": "decision-sell",
            "order_id": "order-sell",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "side": "sell",
            "filled_qty": Decimal("1"),
            "avg_fill_price": Decimal("101"),
            "cost_amount": Decimal("0.02"),
            "cost_basis": "broker_reported_commission_and_fees",
            "execution_policy_hash": "policy-sha",
            "cost_model_hash": "cost-sha",
            "lineage_hash": "lineage-sha",
        },
    ]

    bucket = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.blockers == []
    assert bucket.fill_count == 3
    assert bucket.submitted_order_count == 2
    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert bucket.net_strategy_pnl_after_costs == Decimal("0.96")


def test_exact_replay_ledger_blocks_unfilled_or_unhashed_order_lifecycle() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "decision",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
            {
                "event_type": "order_submitted",
                "executed_at": _ts(2),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.fill_count == 0
    assert bucket.post_cost_expectancy_bps is None
    assert "zero_fill_runtime_ledger" in bucket.blockers
    assert "unfilled_order_present" in bucket.blockers
    assert "cost_model_hash_missing" in bucket.blockers


def test_cancelled_zero_fill_order_does_not_remain_unfilled() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "decision",
                "executed_at": _ts(1),
                "decision_id": "decision-exit",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
            {
                "event_type": "order_submitted",
                "executed_at": _ts(2),
                "decision_id": "decision-exit",
                "order_id": "order-exit",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
            {
                "event_type": "order_cancelled",
                "executed_at": _ts(3),
                "decision_id": "decision-exit",
                "order_id": "order-exit",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.cancelled_order_count == 1
    assert "zero_fill_runtime_ledger" in bucket.blockers
    assert "unfilled_order_present" not in bucket.blockers
