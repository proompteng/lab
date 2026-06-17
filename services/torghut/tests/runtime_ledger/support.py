from __future__ import annotations


from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    RuntimeLedgerFill,
    _build_bucket,
    _coerce_fill_quantity_basis,
    _NormalizedFill,
    build_runtime_ledger_buckets,
)


def _ts(minutes: int = 0) -> datetime:
    return datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc) + timedelta(
        minutes=minutes
    )


def _bucket(rows: list[RuntimeLedgerFill | dict[str, object]]):
    return build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[(_ts(), _ts(60))],
    )[0]


def _assert_decimal_close(actual: Decimal | None, expected: Decimal) -> None:
    assert actual is not None
    assert abs(actual - expected) < Decimal("0.0000000001")


def _source_authority_lifecycle_rows(
    *,
    include_sell: bool = True,
    sell_cost_basis: str | None = "broker_reported_commission_and_fees",
    buy_cost_basis: str | None = "broker_reported_commission_and_fees",
    buy_notional_delta: str | None = "100",
    sell_notional_delta: str | None = "101",
    source_mode: str | None = None,
    pnl_derivation: str | None = None,
) -> list[dict[str, object]]:
    common: dict[str, object] = {
        "account_label": "paper",
        "strategy_id": "strategy-1",
        "symbol": "NVDA",
        "source_materialization": "execution_order_events",
        "authority_class": "runtime_order_feed_execution_source",
        "execution_policy_hash": "policy",
        "cost_model_hash": "broker-cost-v1",
        "lineage_hash": "lineage",
    }
    if source_mode is not None:
        common["source_mode"] = source_mode
    if pnl_derivation is not None:
        common["pnl_derivation"] = pnl_derivation

    rows: list[dict[str, object]] = [
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
            "event_type": "fill",
            "executed_at": _ts(2),
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
            "fill_quantity_basis": "cumulative_to_delta",
            "avg_fill_price": "100",
            "cost_amount": "0.25",
            **(
                {"filled_notional_delta": buy_notional_delta}
                if buy_notional_delta is not None
                else {}
            ),
            **({"cost_basis": buy_cost_basis} if buy_cost_basis is not None else {}),
        },
    ]
    if include_sell:
        rows.extend(
            [
                {
                    **common,
                    "event_type": "decision",
                    "executed_at": _ts(3),
                    "decision_id": "decision-sell",
                    "order_id": "order-sell",
                },
                {
                    **common,
                    "event_type": "order_submitted",
                    "executed_at": _ts(4),
                    "decision_id": "decision-sell",
                    "order_id": "order-sell",
                    "execution_order_event_id": "event-new-sell",
                    "source_window_id": "window-sell",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 8,
                },
                {
                    **common,
                    "event_type": "fill",
                    "executed_at": _ts(5),
                    "decision_id": "decision-sell",
                    "order_id": "order-sell",
                    "execution_order_event_id": "event-fill-sell",
                    "execution_id": "execution-sell",
                    "source_window_id": "window-sell",
                    "source_topic": "alpaca.trade_updates",
                    "source_partition": 0,
                    "source_offset": 9,
                    "side": "sell",
                    "filled_qty_delta": "1",
                    "fill_quantity_basis": "cumulative_to_delta",
                    "avg_fill_price": "101",
                    "cost_amount": "0.25",
                    **(
                        {"filled_notional_delta": sell_notional_delta}
                        if sell_notional_delta is not None
                        else {}
                    ),
                    **(
                        {"cost_basis": sell_cost_basis}
                        if sell_cost_basis is not None
                        else {}
                    ),
                },
            ]
        )
    return rows


__all__: tuple[str, ...] = ()

__all__: tuple[str, ...] = (
    "Decimal",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "RuntimeLedgerFill",
    "_NormalizedFill",
    "_assert_decimal_close",
    "_bucket",
    "_build_bucket",
    "_coerce_fill_quantity_basis",
    "_source_authority_lifecycle_rows",
    "_ts",
    "build_runtime_ledger_buckets",
    "datetime",
    "pytest",
    "timedelta",
    "timezone",
)
