"""Profitability gate regressions for Hyperliquid execution."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.models import (
    Action,
    FeatureSnapshot,
    OrderSide,
    RiskVerdict,
    Signal,
)
from app.hyperliquid_execution.profitability import (
    SymbolProfitabilityState,
    evaluate_profitability_gate,
)


def test_profitability_gate_blocks_after_cost_edge_below_floor() -> None:
    result = evaluate_profitability_gate(
        signal=_signal(edge_bps=Decimal("3")),
        verdict=RiskVerdict("allowed", "allowed", Decimal("10")),
        state=_state(),
        config=HyperliquidExecutionConfig.from_env({}),
        now=_now(),
    )

    assert result.allowed is False
    assert result.reason == "profitability_after_cost_edge_below_floor"


def test_profitability_gate_blocks_losing_symbol_even_with_good_edge() -> None:
    result = evaluate_profitability_gate(
        signal=_signal(edge_bps=Decimal("12")),
        verdict=RiskVerdict("allowed", "allowed", Decimal("10")),
        state=_state(net_pnl_after_fees_usd_24h=Decimal("-0.01")),
        config=HyperliquidExecutionConfig.from_env({}),
        now=_now(),
    )

    assert result.allowed is False
    assert result.reason == "profitability_symbol_net_pnl_24h_negative"


def test_profitability_gate_blocks_turnover_and_recent_flips() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_MAX_SYMBOL_TURNOVER_EQUITY_MULTIPLE_1H": "0.5",
            "HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES": "0",
        }
    )

    turnover = evaluate_profitability_gate(
        signal=_signal(edge_bps=Decimal("12")),
        verdict=RiskVerdict("allowed", "allowed", Decimal("10")),
        state=_state(notional_usd_1h=Decimal("600")),
        config=config,
        now=_now(),
    )

    flip = evaluate_profitability_gate(
        signal=_signal(edge_bps=Decimal("12"), action="sell"),
        verdict=RiskVerdict("allowed", "allowed", Decimal("10")),
        state=_state(
            last_side="buy",
            last_side_at=_now() - timedelta(seconds=30),
        ),
        config=HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES": "0"}
        ),
        now=_now(),
    )

    assert turnover.reason == "profitability_symbol_turnover_cap"
    assert flip.reason == "profitability_side_flip_cooldown"


def test_profitability_gate_blocks_entry_after_reduce_only_position_close() -> None:
    result = evaluate_profitability_gate(
        signal=_signal(edge_bps=Decimal("12"), action="buy"),
        verdict=RiskVerdict("allowed", "allowed", Decimal("10")),
        state=_state(
            last_position_close_side="buy",
            last_position_close_at=_now() - timedelta(seconds=30),
        ),
        config=HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES": "0"}
        ),
        now=_now(),
    )

    assert result.allowed is False
    assert result.reason == "profitability_side_flip_cooldown"
    assert result.last_position_close_side == "buy"


def test_profitability_gate_allows_after_cost_profitable_entry() -> None:
    result = evaluate_profitability_gate(
        signal=_signal(edge_bps=Decimal("12")),
        verdict=RiskVerdict("allowed", "allowed", Decimal("10")),
        state=_state(),
        config=HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES": "0"}
        ),
        now=_now(),
    )

    assert result.allowed is True
    assert result.reason == "allowed"
    assert result.after_cost_edge_bps == Decimal("10")


def _signal(
    *,
    edge_bps: Decimal,
    action: str = "buy",
) -> Signal:
    return Signal(
        market_id="hl:perp:BTC",
        coin="BTC",
        generated_at=_now(),
        action=cast(Action, action),
        edge_bps=edge_bps,
        reason="test",
        feature=FeatureSnapshot(
            market_id="hl:perp:BTC",
            coin="BTC",
            dex="",
            event_ts=_now(),
            price=Decimal("100"),
            momentum_5m_bps=edge_bps,
            spread_bps=Decimal("1"),
            liquidity_usd=Decimal("100000"),
            volatility_bps=Decimal("10"),
            book_imbalance=Decimal("0"),
            source_lag_seconds=1,
            bid_price=Decimal("99.5"),
            ask_price=Decimal("100.5"),
            quote_lag_seconds=1,
        ),
    )


def _state(
    *,
    net_pnl_after_fees_usd_24h: Decimal = Decimal("1"),
    notional_usd_1h: Decimal = Decimal("10"),
    last_side: str | None = None,
    last_side_at: datetime | None = None,
    last_position_close_side: str | None = None,
    last_position_close_at: datetime | None = None,
) -> SymbolProfitabilityState:
    return SymbolProfitabilityState(
        coin="BTC",
        account_value_usd=Decimal("1000"),
        net_pnl_after_fees_usd_24h=net_pnl_after_fees_usd_24h,
        notional_usd_1h=notional_usd_1h,
        last_entry_at=None,
        last_side=cast(OrderSide | None, last_side),
        last_side_at=last_side_at,
        last_position_close_side=cast(OrderSide | None, last_position_close_side),
        last_position_close_at=last_position_close_at,
    )


def _now() -> datetime:
    return datetime(2026, 7, 5, 20, tzinfo=timezone.utc)
