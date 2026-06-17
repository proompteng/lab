from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_ledger.support import (
    Decimal,
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    _bucket,
    _coerce_fill_quantity_basis,
    _source_authority_lifecycle_rows,
    _ts,
    build_runtime_ledger_buckets,
)


def test_source_authority_unfilled_order_keeps_realized_expectancy_blocked() -> None:
    rows = [
        *_source_authority_lifecycle_rows(),
        {
            "event_type": "decision",
            "executed_at": _ts(6),
            "decision_id": "decision-stale",
            "order_id": "order-stale",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "execution_policy_hash": "policy",
            "cost_model_hash": "broker-cost-v1",
            "lineage_hash": "lineage",
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(7),
            "decision_id": "decision-stale",
            "order_id": "order-stale",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "execution_order_event_id": "event-new-stale",
            "source_window_id": "window-stale",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "source_offset": 10,
            "execution_policy_hash": "policy",
            "cost_model_hash": "broker-cost-v1",
            "lineage_hash": "lineage",
        },
        {
            "event_type": "order_unfilled",
            "executed_at": _ts(8),
            "decision_id": "decision-stale",
            "order_id": "order-stale",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "execution_order_event_id": "event-unfilled-stale",
            "source_window_id": "window-stale",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "source_offset": 11,
            "execution_policy_hash": "policy",
            "cost_model_hash": "broker-cost-v1",
            "lineage_hash": "lineage",
        },
    ]

    bucket = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert "unfilled_order_present" in bucket.blockers
    assert bucket.post_cost_expectancy_bps is not None
    assert (
        bucket.diagnostic_closed_trade_expectancy_bps == bucket.post_cost_expectancy_bps
    )


def test_source_authority_extra_submitted_order_does_not_block_closed_trip() -> None:
    rows = [
        *_source_authority_lifecycle_rows(),
        {
            "event_type": "decision",
            "executed_at": _ts(6),
            "decision_id": "decision-pending-terminal",
            "order_id": "order-pending-terminal",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "execution_policy_hash": "policy",
            "cost_model_hash": "broker-cost-v1",
            "lineage_hash": "lineage",
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(7),
            "decision_id": "decision-pending-terminal",
            "order_id": "order-pending-terminal",
            "account_label": "paper",
            "strategy_id": "strategy-1",
            "symbol": "NVDA",
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "execution_order_event_id": "event-new-pending-terminal",
            "source_window_id": "window-pending-terminal",
            "source_topic": "alpaca.trade_updates",
            "source_partition": 0,
            "source_offset": 10,
            "execution_policy_hash": "policy",
            "cost_model_hash": "broker-cost-v1",
            "lineage_hash": "lineage",
        },
    ]

    bucket = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert bucket.unfilled_order_count == 0
    assert "unfilled_order_present" not in bucket.blockers
    assert bucket.post_cost_expectancy_bps is not None


def test_source_authority_open_position_blocks_final_expectancy() -> None:
    bucket = build_runtime_ledger_buckets(
        _source_authority_lifecycle_rows(include_sell=False),
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]

    assert bucket.fill_count == 1
    assert bucket.closed_trade_count == 0
    assert bucket.open_position_count == 1
    assert bucket.filled_notional == Decimal("100")
    assert bucket.post_cost_expectancy_bps is None
    assert "unclosed_position" in bucket.blockers
    assert "closed_round_trip_missing" in bucket.blockers
    assert "filled_notional_missing" not in bucket.blockers
    assert "runtime_ledger_expectancy_missing" in bucket.blockers


def test_source_authority_missing_closed_round_trip_blocks_bucket() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            row
            for row in _source_authority_lifecycle_rows(include_sell=True)
            if row.get("event_type") not in {"fill"}
        ],
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]

    assert bucket.fill_count == 0
    assert bucket.closed_trade_count == 0
    assert bucket.post_cost_expectancy_bps is None
    assert "runtime_fills_missing" in bucket.blockers
    assert "closed_round_trip_missing" in bucket.blockers
    assert "runtime_ledger_expectancy_missing" in bucket.blockers


def test_source_authority_missing_notional_and_cost_basis_block_expectancy() -> None:
    bucket = build_runtime_ledger_buckets(
        _source_authority_lifecycle_rows(
            buy_notional_delta=None,
            sell_notional_delta=None,
            buy_cost_basis=None,
            sell_cost_basis=None,
        ),
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]

    assert bucket.fill_count == 0
    assert bucket.filled_notional == Decimal("0")
    assert bucket.post_cost_expectancy_bps is None
    assert "filled_notional_missing" in bucket.blockers
    assert "cost_basis_missing" in bucket.blockers
    assert "runtime_ledger_expectancy_missing" in bucket.blockers


def test_source_authority_requires_closed_lifecycle_even_without_lifecycle_gate() -> (
    None
):
    common = {
        "event_type": "fill",
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "fill_quantity_basis": "cumulative_to_delta",
        "cost_amount": "0.25",
        "cost_basis": "broker_reported_commission_and_fees",
        "execution_policy_hash": "policy",
        "cost_model_hash": "broker-cost-v1",
        "lineage_hash": "lineage",
    }
    bucket = build_runtime_ledger_buckets(
        [
            {
                **common,
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "execution_order_event_id": "event-fill-buy",
                "execution_id": "execution-buy",
                "source_window_id": "window-buy",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 7,
                "side": "buy",
                "filled_qty_delta": "1",
                "avg_fill_price": "100",
                "filled_notional_delta": "100",
            },
            {
                **common,
                "executed_at": _ts(2),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "execution_order_event_id": "event-fill-sell",
                "execution_id": "execution-sell",
                "source_window_id": "window-sell",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 8,
                "side": "sell",
                "filled_qty_delta": "1",
                "avg_fill_price": "101",
                "filled_notional_delta": "101",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]

    assert bucket.closed_trade_count == 1
    assert bucket.post_cost_expectancy_bps is None
    assert "runtime_decision_lifecycle_missing" in bucket.blockers
    assert "submitted_order_lifecycle_missing" in bucket.blockers


def test_source_decision_collection_mode_is_not_profit_proof_eligible() -> None:
    for marker in ("source_decision", "evidence_collection"):
        bucket = build_runtime_ledger_buckets(
            _source_authority_lifecycle_rows(source_mode=marker),
            bucket_ranges=[(_ts(), _ts(60))],
        )[0]

        assert bucket.fill_count == 2
        assert bucket.closed_trade_count == 1
        assert bucket.filled_notional == Decimal("201")
        assert bucket.post_cost_expectancy_bps is None
        assert bucket.diagnostic_closed_trade_expectancy_bps is not None
        assert "source_decision_mode_not_profit_proof_eligible" in bucket.blockers
        assert "runtime_source_not_promotion_authority" not in bucket.blockers


def test_execution_reconstruction_rows_do_not_become_runtime_authority() -> None:
    bucket = build_runtime_ledger_buckets(
        _source_authority_lifecycle_rows(
            pnl_derivation="execution_reconstruction_basis"
        ),
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]

    assert bucket.fill_count == 0
    assert bucket.post_cost_expectancy_bps is None
    assert "execution_reconstruction_not_runtime_ledger_proof" in bucket.blockers
    assert "runtime_source_not_promotion_authority" in bucket.blockers


def test_promotion_authority_class_requires_source_refs_without_lifecycle_gate() -> (
    None
):
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "authority_class": "source_execution_lifecycle_materialized_runtime_ledger",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "1",
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
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "1",
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
    assert bucket.post_cost_expectancy_bps is None
    assert "runtime_ledger_execution_order_event_refs_missing" in bucket.blockers
    assert "runtime_ledger_trade_decision_refs_missing" in bucket.blockers
    assert "runtime_ledger_execution_refs_missing" in bucket.blockers
    assert "runtime_ledger_source_window_ids_missing" in bucket.blockers
    assert "runtime_ledger_source_offsets_missing" in bucket.blockers


def test_aggregate_only_source_bucket_remains_blocked_from_authority() -> None:
    bucket = _bucket(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(1),
                "source_materialization": "aggregate_only",
                "authority_class": "aggregate_only",
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
                "filled_qty": "1",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
            {
                "event_type": "fill",
                "executed_at": _ts(2),
                "source_materialization": "aggregate_only",
                "authority_class": "aggregate_only",
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
                "filled_qty": "1",
                "filled_qty_delta": "1",
                "fill_quantity_basis": "cumulative_to_delta",
                "avg_fill_price": "101",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
        ]
    )

    assert bucket.fill_count == 0
    assert bucket.post_cost_expectancy_bps is None
    assert "runtime_source_not_promotion_authority" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers


def test_promotion_authority_class_also_requires_source_materialization() -> None:
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
                "filled_qty": "1",
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
                "filled_qty": "1",
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
    assert bucket.post_cost_expectancy_bps is None
    assert "runtime_ledger_source_materialization_missing" in bucket.blockers
    assert "runtime_ledger_authority_class_missing" not in bucket.blockers


def test_fill_quantity_basis_aliases_are_normalized() -> None:
    assert _coerce_fill_quantity_basis("fill-delta") == "delta"
    assert _coerce_fill_quantity_basis("cum") == "cumulative"
    assert _coerce_fill_quantity_basis("unknown") == "unknown"
    assert (
        _coerce_fill_quantity_basis("cumulative-non-increasing")
        == "cumulative_non_increasing"
    )
    assert _coerce_fill_quantity_basis("broker custom") == "broker_custom"


def test_exact_replay_ledger_requires_order_lifecycle_and_hash_lineage() -> None:
    common = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "execution_policy_hash": "policy-sha",
        "cost_model_hash": "cost-sha",
        "lineage_hash": "lineage-sha",
    }
    bucket = build_runtime_ledger_buckets(
        [
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(2),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(3),
                "order_id": "order-buy",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1",
                "cost_basis": "broker_reported_commission_and_fees",
            },
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(10),
                "decision_id": "decision-sell",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(11),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(12),
                "order_id": "order-sell",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.blockers == []
    assert bucket.ledger_schema_version == EXACT_REPLAY_LEDGER_SCHEMA_VERSION
    assert bucket.decision_count == 2
    assert bucket.submitted_order_count == 2
    assert bucket.fill_count == 2
    assert bucket.net_strategy_pnl_after_costs == Decimal("97")
    assert bucket.execution_policy_hash_counts == {"policy-sha": 6}
    assert bucket.cost_model_hash_counts == {"cost-sha": 2}
    assert bucket.lineage_hash_counts == {"lineage-sha": 6}
    assert bucket.post_cost_expectancy_bps is not None


def test_exact_replay_ledger_does_not_use_idempotency_key_as_policy_hash() -> None:
    common = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "cost_model_hash": "cost-sha",
        "lineage_hash": "lineage-sha",
    }
    bucket = build_runtime_ledger_buckets(
        [
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
                "execution_idempotency_key": "buy-decision-key",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(2),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "execution_idempotency_key": "buy-order-key",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(3),
                "order_id": "order-buy",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1",
                "cost_basis": "broker_reported_commission_and_fees",
                "execution_idempotency_key": "buy-fill-key",
            },
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(10),
                "decision_id": "decision-sell",
                "execution_idempotency_key": "sell-decision-key",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(11),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "execution_idempotency_key": "sell-order-key",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(12),
                "order_id": "order-sell",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "broker_reported_commission_and_fees",
                "execution_idempotency_key": "sell-fill-key",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.execution_policy_hash_counts == {}
    assert "execution_policy_hash_missing" in bucket.blockers
    assert "execution_policy_hash_ambiguous" not in bucket.blockers
    assert bucket.cost_model_hash_counts == {"cost-sha": 2}
    assert bucket.lineage_hash_counts == {"lineage-sha": 6}


def test_runtime_ledger_cost_hash_belongs_to_fill_economics_not_lifecycle() -> None:
    lifecycle_common = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "lineage_hash": "lineage-sha",
    }
    bucket = build_runtime_ledger_buckets(
        [
            {
                **lifecycle_common,
                "event_type": "decision",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
            },
            {
                **lifecycle_common,
                "event_type": "order_submitted",
                "executed_at": _ts(2),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "execution_policy_hash": "policy-buy",
            },
            {
                **lifecycle_common,
                "event_type": "fill",
                "executed_at": _ts(3),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1",
                "cost_basis": "broker_reported_commission_and_fees",
                "execution_policy_hash": "policy-buy",
                "cost_model_hash": "cost-sha",
            },
            {
                **lifecycle_common,
                "event_type": "decision",
                "executed_at": _ts(10),
                "decision_id": "decision-sell",
            },
            {
                **lifecycle_common,
                "event_type": "order_submitted",
                "executed_at": _ts(11),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "execution_policy_hash": "policy-sell",
            },
            {
                **lifecycle_common,
                "event_type": "fill",
                "executed_at": _ts(12),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "broker_reported_commission_and_fees",
                "execution_policy_hash": "policy-sell",
                "cost_model_hash": "cost-sha",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.blockers == []
    assert bucket.execution_policy_hash_counts == {"policy-buy": 2, "policy-sell": 2}
    assert bucket.cost_model_hash_counts == {"cost-sha": 2}
    assert bucket.lineage_hash_counts == {"lineage-sha": 6}
    assert bucket.post_cost_expectancy_bps is not None


def test_runtime_ledger_blocks_non_promotion_grade_cost_basis_at_builder() -> None:
    common = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "execution_policy_hash": "policy-sha",
        "cost_model_hash": "cost-sha",
        "lineage_hash": "lineage-sha",
    }
    bucket = build_runtime_ledger_buckets(
        [
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(1),
                "decision_id": "decision-buy",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(2),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(3),
                "order_id": "order-buy",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1",
                "cost_basis": "modeled_paper_cost_budget",
            },
            {
                **common,
                "event_type": "decision",
                "executed_at": _ts(10),
                "decision_id": "decision-sell",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(11),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(12),
                "order_id": "order-sell",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "modeled_paper_cost_budget",
            },
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        require_order_lifecycle=True,
    )[0]

    assert bucket.fill_count == 0
    assert bucket.net_strategy_pnl_after_costs == Decimal("0")
    assert bucket.cost_basis_counts == {}
    assert "runtime_ledger_cost_basis_non_promotion_grade" in bucket.blockers
    assert bucket.post_cost_expectancy_bps is None
