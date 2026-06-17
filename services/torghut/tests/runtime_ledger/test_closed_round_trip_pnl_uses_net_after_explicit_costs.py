from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_ledger.support import (
    Decimal,
    RuntimeLedgerFill,
    _assert_decimal_close,
    _bucket,
    _ts,
    build_runtime_ledger_buckets,
    pytest,
)


def test_closed_round_trip_pnl_uses_net_after_explicit_costs() -> None:
    bucket = _bucket(
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
        ]
    )

    assert bucket.blockers == []
    assert bucket.filled_notional == Decimal("2100")
    assert bucket.gross_strategy_pnl == Decimal("100")
    assert bucket.cost_amount == Decimal("3")
    assert bucket.net_strategy_pnl_after_costs == Decimal("97")
    assert bucket.pnl_basis == "realized_strategy_pnl_after_explicit_costs"
    assert bucket.cost_basis_counts == {"broker_reported_commission_and_fees": 2}
    _assert_decimal_close(
        bucket.post_cost_expectancy_bps,
        (Decimal("97") / Decimal("2100")) * Decimal("10000"),
    )


def test_tigerbeetle_execution_cost_journal_failure_blocks_authority() -> None:
    bucket = _bucket(
        [
            {
                "executed_at": _ts(1),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1.00",
                "cost_basis": "broker_reported_commission_and_fees",
                "tigerbeetle_execution_cost_journal_status": "blocked",
                "tigerbeetle_execution_cost_journal_blockers": [
                    "tigerbeetle_transfer_ref_conflict:amount",
                    "",
                ],
            },
            {
                "executed_at": _ts(12),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2.00",
                "cost_basis": "broker_reported_commission_and_fees",
                "tigerbeetle_execution_cost_journal_status": "created",
            },
        ]
    )

    assert "tigerbeetle_execution_cost_journal_failed" in bucket.blockers
    assert "tigerbeetle_transfer_ref_conflict:amount" in bucket.blockers
    assert bucket.cost_amount == Decimal("0")
    assert bucket.net_strategy_pnl_after_costs == Decimal("0")
    assert bucket.post_cost_expectancy_bps is None


def test_partial_unclosed_positions_report_realized_pnl_but_block_expectancy() -> None:
    bucket = _bucket(
        [
            {
                "executed_at": _ts(1),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1.00",
                "cost_basis": "broker_reported_commission_and_fees",
            },
            {
                "executed_at": _ts(12),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "4",
                "avg_fill_price": "110",
                "cost_amount": "1.00",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ]
    )

    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 1
    assert "unclosed_position" in bucket.blockers
    assert bucket.filled_notional == Decimal("1440")
    assert bucket.gross_strategy_pnl == Decimal("40")
    assert bucket.net_strategy_pnl_after_costs == Decimal("38.60")
    assert bucket.post_cost_expectancy_bps is None
    _assert_decimal_close(
        bucket.diagnostic_closed_trade_expectancy_bps,
        (Decimal("38.60") / Decimal("840")) * Decimal("10000"),
    )


def test_missing_price_notional_and_cost_basis_are_blockers() -> None:
    bucket = _bucket(
        [
            {
                "executed_at": _ts(1),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "10",
                "cost_amount": "0",
            }
        ]
    )

    assert "fill_price_missing" in bucket.blockers
    assert "filled_notional_missing" in bucket.blockers
    assert "cost_basis_missing" in bucket.blockers
    assert bucket.filled_notional == Decimal("0")
    assert bucket.post_cost_expectancy_bps is None


def test_explicit_costs_are_deducted_from_gross_pnl() -> None:
    no_cost_bucket = _bucket(
        [
            RuntimeLedgerFill(
                executed_at=_ts(1),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(12),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="sell",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("110"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
        ]
    )
    cost_bucket = _bucket(
        [
            RuntimeLedgerFill(
                executed_at=_ts(1),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("7.50"),
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
                cost_amount=Decimal("7.50"),
                cost_basis="broker_reported_commission_and_fees",
            ),
        ]
    )

    assert no_cost_bucket.gross_strategy_pnl == Decimal("100")
    assert no_cost_bucket.net_strategy_pnl_after_costs == Decimal("100")
    assert cost_bucket.gross_strategy_pnl == Decimal("100")
    assert cost_bucket.net_strategy_pnl_after_costs == Decimal("85.00")
    assert (
        cost_bucket.post_cost_expectancy_bps != no_cost_bucket.post_cost_expectancy_bps
    )


def test_post_cost_expectancy_is_notional_weighted_across_closed_trips() -> None:
    bucket = _bucket(
        [
            RuntimeLedgerFill(
                executed_at=_ts(1),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(2),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="sell",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("101"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(3),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(4),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="sell",
                filled_qty=Decimal("10"),
                avg_fill_price=Decimal("102"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
        ]
    )
    arithmetic_average_bps = (
        (Decimal("1") / Decimal("201")) * Decimal("10000")
        + (Decimal("20") / Decimal("2020")) * Decimal("10000")
    ) / Decimal("2")

    assert bucket.filled_notional == Decimal("2221")
    assert bucket.net_strategy_pnl_after_costs == Decimal("21")
    _assert_decimal_close(
        bucket.post_cost_expectancy_bps,
        (Decimal("21") / Decimal("2221")) * Decimal("10000"),
    )
    assert bucket.post_cost_expectancy_bps != arithmetic_average_bps


def test_positions_carry_across_bucket_boundaries() -> None:
    buckets = build_runtime_ledger_buckets(
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
                executed_at=_ts(35),
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
        bucket_ranges=[(_ts(), _ts(30)), (_ts(30), _ts(60))],
    )

    assert buckets[0].closed_trade_count == 0
    assert "unclosed_position" in buckets[0].blockers
    assert buckets[0].post_cost_expectancy_bps is None
    assert buckets[1].blockers == []
    assert buckets[1].closed_trade_count == 1
    assert buckets[1].filled_notional == Decimal("2100")
    assert buckets[1].net_strategy_pnl_after_costs == Decimal("97")
    _assert_decimal_close(
        buckets[1].post_cost_expectancy_bps,
        (Decimal("97") / Decimal("2100")) * Decimal("10000"),
    )


def test_grouped_positions_carry_across_bucket_boundaries() -> None:
    buckets = build_runtime_ledger_buckets(
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
                executed_at=_ts(35),
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
        bucket_ranges=[(_ts(), _ts(30)), (_ts(30), _ts(60))],
        group_by=("strategy_id", "symbol"),
    )

    assert len(buckets) == 2
    assert buckets[0].closed_trade_count == 0
    assert "unclosed_position" in buckets[0].blockers
    assert buckets[1].blockers == []
    assert buckets[1].closed_trade_count == 1
    assert buckets[1].open_position_count == 0
    assert buckets[1].filled_notional == Decimal("2100")
    assert buckets[1].net_strategy_pnl_after_costs == Decimal("97")
    _assert_decimal_close(
        buckets[1].post_cost_expectancy_bps,
        (Decimal("97") / Decimal("2100")) * Decimal("10000"),
    )


def test_source_backed_carry_in_closes_position_opened_before_bucket() -> None:
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
                "executed_at": _ts(35),
                "decision_id": "decision-sell",
            },
            {
                **common,
                "event_type": "order_submitted",
                "executed_at": _ts(36),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "execution_policy_hash": "policy-sell",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(37),
                "decision_id": "decision-sell",
                "order_id": "order-sell",
                "execution_policy_hash": "policy-sell",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ],
        carry_in_rows=[
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
                "execution_policy_hash": "policy-buy",
            },
            {
                **common,
                "event_type": "fill",
                "executed_at": _ts(3),
                "decision_id": "decision-buy",
                "order_id": "order-buy",
                "execution_policy_hash": "policy-buy",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ],
        bucket_ranges=[(_ts(30), _ts(60))],
        group_by=("symbol",),
        require_order_lifecycle=True,
    )[0]

    assert bucket.blockers == []
    assert bucket.closed_trade_count == 1
    assert bucket.open_position_count == 0
    assert bucket.filled_notional == Decimal("2100")
    assert bucket.cost_amount == Decimal("3")
    assert bucket.net_strategy_pnl_after_costs == Decimal("97")
    assert bucket.cost_basis_counts == {"broker_reported_commission_and_fees": 2}
    assert bucket.cost_model_hash_counts == {"cost-sha": 2}
    assert bucket.execution_policy_hash_counts == {
        "policy-buy": 2,
        "policy-sell": 2,
    }
    _assert_decimal_close(
        bucket.post_cost_expectancy_bps,
        (Decimal("97") / Decimal("2100")) * Decimal("10000"),
    )


def test_sell_without_carry_in_stays_fail_closed() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(37),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ],
        bucket_ranges=[(_ts(30), _ts(60))],
    )[0]

    assert bucket.closed_trade_count == 0
    assert bucket.open_position_count == 1
    assert "closed_round_trip_missing" in bucket.blockers
    assert "unclosed_position" in bucket.blockers
    assert bucket.post_cost_expectancy_bps is None


def test_carry_in_non_promotion_cost_basis_blocks_bucket() -> None:
    bucket = build_runtime_ledger_buckets(
        [
            {
                "event_type": "fill",
                "executed_at": _ts(37),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "sell",
                "filled_qty": "10",
                "avg_fill_price": "110",
                "cost_amount": "2",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ],
        carry_in_rows=[
            {
                "event_type": "fill",
                "executed_at": _ts(3),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "10",
                "avg_fill_price": "100",
                "cost_amount": "1",
                "cost_basis": "paper_cost_model_estimate",
            },
        ],
        bucket_ranges=[(_ts(30), _ts(60))],
    )[0]

    assert bucket.closed_trade_count == 0
    assert bucket.open_position_count == 1
    assert "runtime_ledger_cost_basis_non_promotion_grade" in bucket.blockers
    assert "unclosed_position" in bucket.blockers
    assert bucket.post_cost_expectancy_bps is None


def test_tca_shortfall_rows_do_not_count_as_strategy_pnl() -> None:
    bucket = _bucket(
        [
            {
                "computed_at": _ts(5),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "shortfall_notional": "-120.50",
                "post_cost_expectancy_bps": "32.5",
                "post_cost_expectancy_basis": "broker_tca_shortfall_estimate",
                "filled_notional": "10000",
            }
        ]
    )

    assert "tca_shortfall_not_runtime_pnl" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers
    assert bucket.filled_notional == Decimal("0")
    assert bucket.net_strategy_pnl_after_costs == Decimal("0")
    assert bucket.post_cost_expectancy_bps is None


def test_invalid_bucket_range_is_rejected_before_profit_proof() -> None:
    naive_start = _ts().replace(tzinfo=None)

    with pytest.raises(ValueError, match="bucket_end_must_be_after_bucket_start"):
        build_runtime_ledger_buckets(
            [],
            bucket_ranges=[(naive_start, naive_start)],
        )


def test_grouped_buckets_preserve_runtime_identity_fields() -> None:
    buckets = build_runtime_ledger_buckets(
        [
            RuntimeLedgerFill(
                executed_at=_ts(1),
                account_label="paper",
                strategy_id="strategy-a",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("0.10"),
                cost_basis="broker_reported_commission_and_fees",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(2),
                account_label="paper",
                strategy_id="strategy-a",
                symbol="NVDA",
                side="sell",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("101"),
                cost_amount=Decimal("0.10"),
                cost_basis="broker_reported_commission_and_fees",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(3),
                account_label="paper",
                strategy_id="strategy-b",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("50"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(4),
                account_label="paper",
                strategy_id="strategy-b",
                symbol="AAPL",
                side="sell",
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("51"),
                cost_amount=Decimal("0"),
                cost_basis="broker_reported_zero_cost",
            ),
        ],
        bucket_ranges=[(_ts(), _ts(60))],
        group_by=("strategy_id", "symbol"),
    )

    assert [(bucket.strategy_id, bucket.symbol) for bucket in buckets] == [
        ("strategy-a", "NVDA"),
        ("strategy-b", "AAPL"),
    ]
    assert all(bucket.account_label == "paper" for bucket in buckets)
    assert all(bucket.blockers == [] for bucket in buckets)
    assert [bucket.net_strategy_pnl_after_costs for bucket in buckets] == [
        Decimal("0.80"),
        Decimal("2"),
    ]


def test_reversal_closes_long_then_realizes_short_pnl_after_costs() -> None:
    bucket = _bucket(
        [
            RuntimeLedgerFill(
                executed_at=_ts(1),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("5"),
                avg_fill_price=Decimal("100"),
                cost_amount=Decimal("0.50"),
                cost_basis="broker_reported_commission_and_fees",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(2),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy",
                filled_qty=Decimal("5"),
                avg_fill_price=Decimal("120"),
                cost_amount=Decimal("0.50"),
                cost_basis="broker_reported_commission_and_fees",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(3),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="sell",
                filled_qty=Decimal("12"),
                avg_fill_price=Decimal("130"),
                cost_amount=Decimal("1.20"),
                cost_basis="broker_reported_commission_and_fees",
            ),
            RuntimeLedgerFill(
                executed_at=_ts(4),
                account_label="paper",
                strategy_id="strategy-1",
                symbol="NVDA",
                side="buy_to_cover",
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("120"),
                cost_amount=Decimal("0.20"),
                cost_basis="broker_reported_commission_and_fees",
            ),
        ]
    )

    assert bucket.blockers == []
    assert bucket.closed_trade_count == 2
    assert bucket.open_position_count == 0
    assert bucket.filled_notional == Decimal("2900")
    assert bucket.gross_strategy_pnl == Decimal("220")
    assert bucket.cost_amount == Decimal("2.40")
    assert bucket.net_strategy_pnl_after_costs == Decimal("217.60")
    _assert_decimal_close(
        bucket.post_cost_expectancy_bps,
        (Decimal("217.60") / Decimal("2900")) * Decimal("10000"),
    )


def test_invalid_runtime_fill_fields_fail_closed() -> None:
    bucket = _bucket(
        [
            {
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "1",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
            {
                "executed_at": "not-a-date",
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "buy",
                "filled_qty": "1",
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            },
            {
                "executed_at": _ts(5),
                "account_label": "paper",
                "strategy_id": "strategy-1",
                "symbol": "NVDA",
                "side": "hold",
                "filled_qty": "not-a-number",
                "avg_fill_price": "NaN",
                "filled_notional": "Infinity",
                "cost_amount": "Infinity",
                "cost_basis": "broker_reported_commission_and_fees",
            },
        ]
    )

    assert bucket.fill_count == 0
    assert "side_missing_or_invalid" in bucket.blockers
    assert "filled_qty_missing_or_non_positive" in bucket.blockers
    assert "fill_price_missing" in bucket.blockers
    assert "filled_notional_missing" in bucket.blockers
    assert "explicit_cost_missing" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers


def test_order_feed_source_fill_requires_delta_basis() -> None:
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
                "avg_fill_price": "100",
                "cost_amount": "0",
                "cost_basis": "broker_reported_zero_cost",
            }
        ]
    )

    assert bucket.fill_count == 0
    assert "fill_quantity_delta_basis_missing" in bucket.blockers
    assert "runtime_fills_missing" in bucket.blockers
