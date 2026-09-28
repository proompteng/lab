from __future__ import annotations

from tests.runtime_ledger.support import (
    Decimal,
    _bucket,
    _source_authority_lifecycle_rows,
    _ts,
    build_runtime_ledger_buckets,
)


def test_order_feed_lifecycle_fill_without_execution_economics_is_not_pnl_proof() -> (
    None
):
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "decision",
                "executed_at": _ts(0),
                "decision_id": "decision-1",
                "order_id": "order-1",
                "execution_policy_hash": "policy",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "new",
                "executed_at": _ts(1),
                "source": "order_feed_lifecycle",
                "decision_id": "decision-1",
                "order_id": "order-1",
                "execution_policy_hash": "policy",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(2),
                "source": "order_feed_lifecycle",
                "execution_order_event_id": "event-1",
                "source_window_id": "window-1",
                "source_offset": 7,
                "decision_id": "decision-1",
                "order_id": "order-1",
                "filled_qty": "1",
                "avg_fill_price": "100",
                "lineage_hash": "lineage",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.fill_count == 0
    assert bucket.post_cost_expectancy_bps is None
    assert "execution_economics_missing" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers
    assert "explicit_cost_missing" not in bucket.blockers


def test_execution_economics_with_linked_order_feed_lifecycle_satisfies_runtime_inputs() -> (
    None
):
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "decision",
                "executed_at": _ts(0),
                "decision_id": "decision-1",
                "order_id": "order-buy",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "new",
                "executed_at": _ts(1),
                "source": "order_feed_lifecycle",
                "decision_id": "decision-1",
                "order_id": "order-buy",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "new",
                "executed_at": _ts(2),
                "source": "order_feed_lifecycle",
                "decision_id": "decision-2",
                "order_id": "order-sell",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(3),
                "source": "order_feed_lifecycle",
                "execution_order_event_id": "event-buy",
                "source_window_id": "window-buy",
                "source_offset": 7,
                "decision_id": "decision-1",
                "order_id": "order-buy",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(4),
                "source": "order_feed_lifecycle",
                "execution_order_event_id": "event-sell",
                "source_window_id": "window-sell",
                "source_offset": 8,
                "decision_id": "decision-2",
                "order_id": "order-sell",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(3),
                "source": "runtime_execution",
                "decision_id": "decision-1",
                "order_id": "order-buy",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "1",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(4),
                "source": "runtime_execution",
                "decision_id": "decision-2",
                "order_id": "order-sell",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "1",
                "avg_fill_price": "101",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.fill_count == 2
    assert bucket.closed_trade_count == 1
    assert bucket.post_cost_expectancy_bps is not None
    assert "order_feed_lifecycle_missing" not in bucket.blockers
    assert "execution_economics_missing" not in bucket.blockers


def test_execution_economics_requires_matching_order_feed_fill_lifecycle() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "decision",
                "executed_at": _ts(0),
                "decision_id": "decision-1",
                "order_id": "order-1",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "new",
                "executed_at": _ts(1),
                "source": "order_feed_lifecycle",
                "decision_id": "decision-1",
                "order_id": "order-1",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(2),
                "source": "runtime_execution",
                "decision_id": "decision-1",
                "order_id": "order-1",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "1",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
                "execution_policy_hash": "policy",
                "cost_model_hash": "cost-model",
                "lineage_hash": "lineage",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert "order_feed_lifecycle_missing" in bucket.blockers


def test_order_feed_source_fill_requires_positive_delta_quantity() -> None:
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "source": "execution_order_event",
                "execution_order_event_id": "event-1",
                "source_window_id": "window-1",
                "source_offset": 7,
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "1",
                "fill_quantity_basis": "delta",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            }
        ]
    )

    assert bucket.fill_count == 0
    assert "fill_quantity_delta_missing" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers


def test_order_feed_source_fill_uses_delta_not_cumulative_quantity() -> None:
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "source": "execution_order_event",
                "execution_order_event_id": "event-buy",
                "source_window_id": "window-buy",
                "source_offset": 7,
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "2",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(2),
                "source": "execution_order_event",
                "execution_order_event_id": "event-sell",
                "source_window_id": "window-sell",
                "source_offset": 8,
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "2",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "101",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
        ]
    )

    assert bucket.fill_count == 2
    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert bucket.filled_notional == Decimal("201")
    assert bucket.gross_strategy_pnl == Decimal("1")


def test_linked_order_feed_fill_materializes_fill_economics_lineage() -> None:
    common = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "execution_policy_hash": "policy",
        "cost_model_hash": "broker-cost-v1",
        "lineage_hash": "lineage",
    }

    bucket = build_runtime_ledger_buckets(
        [
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(0),
                "decision_id": "decision-buy",
                "order_id": "execution-buy",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
                "order_id": "execution-buy",
                "execution_order_event_id": "event-new-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 6,
            },
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(2),
                "decision_id": "decision-sell",
                "order_id": "execution-sell",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(3),
                "decision_id": "decision-sell",
                "order_id": "execution-sell",
                "execution_order_event_id": "event-new-sell",
                "source_window_id": "window-sell",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 7,
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(4),
                "execution_order_event_id": "event-buy",
                "execution_id": "execution-buy",
                "trade_decision_id": "decision-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 8,
                "side": "buy",
                "quantity": "1",
                "avg_fill_price": "100",
                "filled_notional_delta": "100",
                "explicit_cost_amount": "0.25",
                "broker_fee_basis": "broker_reported_commission_and_fees",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(5),
                "execution_order_event_id": "event-sell",
                "execution_id": "execution-sell",
                "trade_decision_id": "decision-sell",
                "source_window_id": "window-sell",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 9,
                "side": "sell",
                "quantity": "1",
                "avg_fill_price": "101",
                "filled_notional_delta": "101",
                "broker_fee": "0.25",
                "broker_fee_basis": "broker_reported_commission_and_fees",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.blockers == []
    assert bucket.fill_count == 2
    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert bucket.filled_notional == Decimal("201")
    assert bucket.cost_amount == Decimal("0.50")
    assert bucket.net_strategy_pnl_after_costs == Decimal("0.50")
    assert bucket.cost_basis_counts == {"broker_reported_commission_and_fees": 2}
    assert bucket.cost_model_hash_counts == {"broker-cost-v1": 2}
    assert bucket.post_cost_expectancy_bps is not None


def test_source_materialized_fill_requires_execution_refs_for_authority() -> None:
    common = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "execution_policy_hash": "policy",
        "cost_model_hash": "broker-cost-v1",
        "lineage_hash": "lineage",
    }

    bucket = build_runtime_ledger_buckets(
        [
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(0),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "execution_order_event_id": "event-new-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 6,
            },
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(2),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(3),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "execution_order_event_id": "event-new-sell",
                "source_window_id": "window-sell",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 7,
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(4),
                "execution_order_event_id": "event-buy",
                "trade_decision_id": "decision-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 8,
                "order_id": "order-buy",
                "side": "buy",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "100",
                "explicit_cost_amount": "0.25",
                "broker_fee_basis": "broker_reported_commission_and_fees",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(5),
                "execution_order_event_id": "event-sell",
                "trade_decision_id": "decision-sell",
                "source_window_id": "window-sell",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 9,
                "order_id": "order-sell",
                "side": "sell",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "101",
                "broker_fee": "0.25",
                "broker_fee_basis": "broker_reported_commission_and_fees",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.closed_trade_count == 1
    assert bucket.diagnostic_closed_trade_expectancy_bps is not None
    assert bucket.post_cost_expectancy_bps is None
    assert "runtime_ledger_execution_refs_missing" in bucket.blockers


def test_linked_order_feed_fill_accepts_structured_source_offsets_mapping() -> None:
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "execution_order_event_id": "event-buy",
                "execution_id": "execution-buy",
                "trade_decision_id": "decision-buy",
                "source_window_id": "window-buy",
                "source_offsets": {
                    "topic": "alpaca.trade_updates",
                    "partition": 0,
                    "offset": 7,
                },
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "avg_fill_price": "100",
                "filled_notional_delta": "100",
                "broker_fee": "0",
                "broker_fee_basis": "broker_reported_zero_cost",
            }
        ]
    )

    assert bucket.fill_count == 1
    assert bucket.filled_notional == Decimal("100")
    assert "runtime_fills_missing" not in bucket.blockers
    assert "filled_notional_missing" not in bucket.blockers
    assert "closed_round_trip_missing" in bucket.blockers
    assert "unclosed_position" in bucket.blockers


def test_linked_order_feed_fill_without_explicit_costs_stays_non_authority() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "decision",
                "executed_at": _ts(0),
                "decision_id": "decision-buy",
                "order_id": "execution-buy",
                "execution_policy_hash": "policy",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "order_submitted",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
                "order_id": "execution-buy",
                "execution_policy_hash": "policy",
                "lineage_hash": "lineage",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(2),
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "execution_order_event_id": "event-buy",
                "execution_id": "execution-buy",
                "trade_decision_id": "decision-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 7,
                "side": "buy",
                "quantity": "1",
                "avg_fill_price": "100",
                "filled_notional_delta": "100",
                "execution_policy_hash": "policy",
                "lineage_hash": "lineage",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.fill_count == 0
    assert bucket.post_cost_expectancy_bps is None
    assert "execution_economics_missing" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers


def test_probe_route_order_feed_fill_remains_non_promotion_authority() -> None:
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "source_kind": "paper_route_probe_runtime_observed",
                "promotion_authority": False,
                "execution_order_event_id": "event-buy",
                "execution_id": "execution-buy",
                "trade_decision_id": "decision-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 7,
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "quantity": "1",
                "avg_fill_price": "100",
                "filled_notional_delta": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            }
        ]
    )

    assert bucket.fill_count == 0
    assert "runtime_source_not_promotion_authority" in bucket.blockers
    assert bucket.post_cost_expectancy_bps is None


def test_non_promotion_source_marker_strings_block_fill_authority() -> None:
    for marker in (
        {"promotion_authority": "false"},
        {"authority_reason": "route_reacquisition"},
    ):
        bucket = _bucket(
            [
                {
                    "event_type": "fill",
                    "executed_at": _ts(1),
                    "source_materialization": "execution_order_events",
                    "authority_class": "runtime_order_feed_execution_source",
                    **marker,
                    "execution_order_event_id": "event-buy",
                    "execution_id": "execution-buy",
                    "trade_decision_id": "decision-buy",
                    "source_window_id": "window-buy",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 7,
                    "account_label": "paper",
                    "strategy_id": "strategy-1",
                    "symbol": "NVDA",
                    "side": "buy",
                    "quantity": "1",
                    "avg_fill_price": "100",
                    "filled_notional_delta": "100",
                    "cost_amount": "0",
                    "cost_basis": "broker_reported_zero_cost",
                }
            ]
        )

        assert bucket.fill_count == 0
        assert "runtime_source_not_promotion_authority" in bucket.blockers


def test_order_feed_source_fill_accepts_authority_class_marker() -> None:
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "authority_class": "source_execution_lifecycle_materialized_runtime_ledger",
                "execution_order_event_id": "event-buy",
                "execution_id": "execution-buy",
                "trade_decision_id": "decision-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 7,
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "2",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(2),
                "authority_class": "source_execution_lifecycle_materialized_runtime_ledger",
                "execution_order_event_id": "event-sell",
                "execution_id": "execution-sell",
                "trade_decision_id": "decision-sell",
                "source_window_id": "window-sell",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 8,
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "2",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "101",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
        ]
    )

    assert bucket.fill_count == 2
    assert bucket.closed_trade_count == 1
    assert bucket.filled_notional == Decimal("201")


def test_source_authority_lifecycle_rows_can_be_clean_evidence_candidate() -> None:
    bucket = build_runtime_ledger_buckets(
        _source_authority_lifecycle_rows(),
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]

    assert bucket.blockers == []
    assert bucket.fill_count == 2
    assert bucket.decision_count == 2
    assert bucket.submitted_order_count == 2
    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert bucket.filled_notional == Decimal("201")
    assert bucket.cost_basis_counts == {"broker_reported_commission_and_fees": 2}
    assert bucket.post_cost_expectancy_bps is not None
