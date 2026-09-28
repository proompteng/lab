"""Regression tests for Hyperliquid execution margin budgeting."""

from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.margin import (
    gross_margin_over_budget,
    gross_margin_used_usd,
    over_budget_coins,
    resolve_margin_budget,
)
from app.hyperliquid_execution.models import RiskState


def test_gross_margin_use_counts_unmapped_raw_account_exposure() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    state = _risk_state(
        gross_exposure_usd=Decimal("7000"),
        symbol_exposure_usd_by_coin={"NVDA": Decimal("1000")},
        max_leverage_by_coin={"NVDA": Decimal("20")},
    )

    assert gross_margin_used_usd(state) == Decimal("6050.000000")
    assert gross_margin_over_budget(state=state, config=config)


def test_gross_margin_use_keeps_raw_position_offset_position_only() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    state = _risk_state(
        gross_exposure_usd=Decimal("7000"),
        symbol_exposure_usd_by_coin={"NVDA": Decimal("3000")},
        position_exposure_usd_by_coin={"NVDA": Decimal("1000")},
        max_leverage_by_coin={"NVDA": Decimal("20")},
    )

    assert gross_margin_used_usd(state) == Decimal("6150.000000")
    assert gross_margin_over_budget(state=state, config=config)


def test_gross_margin_use_treats_empty_position_map_as_authoritative() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    state = _risk_state(
        gross_exposure_usd=Decimal("7000"),
        symbol_exposure_usd_by_coin={"NVDA": Decimal("3000")},
        position_exposure_usd_by_coin={},
        max_leverage_by_coin={"NVDA": Decimal("20")},
    )

    assert gross_margin_used_usd(state) == Decimal("7150.000000")
    assert gross_margin_over_budget(state=state, config=config)


def test_sub_min_residual_capacity_does_not_mark_symbol_over_budget() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD": "12"}
    )
    state = _risk_state(
        gross_exposure_usd=Decimal("1589"),
        symbol_exposure_usd_by_coin={"NVDA": Decimal("1589")},
        max_leverage_by_coin={"NVDA": Decimal("20")},
    )

    budget, blocker = resolve_margin_budget(
        coin="NVDA",
        state=state,
        config=config,
    )

    assert budget is not None
    assert blocker == "margin_capacity_below_min_order"
    assert budget.remaining_symbol_margin_usd == Decimal("0.550000")
    assert budget.order_notional_capacity_usd == Decimal("11.000000")
    assert not budget.over_budget
    assert over_budget_coins(state=state, config=config) == set()


def test_symbol_over_budget_is_detected_with_zero_withdrawable_margin() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    under_symbol_cap = _risk_state(
        withdrawable_usd=Decimal("0"),
        gross_exposure_usd=Decimal("1000"),
        symbol_exposure_usd_by_coin={"NVDA": Decimal("1000")},
        max_leverage_by_coin={"NVDA": Decimal("20")},
    )
    over_symbol_cap = _risk_state(
        withdrawable_usd=Decimal("0"),
        gross_exposure_usd=Decimal("1700"),
        symbol_exposure_usd_by_coin={"NVDA": Decimal("1700")},
        max_leverage_by_coin={"NVDA": Decimal("20")},
    )

    under_budget, under_blocker = resolve_margin_budget(
        coin="NVDA",
        state=under_symbol_cap,
        config=config,
    )
    over_budget, over_blocker = resolve_margin_budget(
        coin="NVDA",
        state=over_symbol_cap,
        config=config,
    )

    assert under_budget is not None
    assert under_blocker == "margin_capacity_below_min_order"
    assert not under_budget.over_budget
    assert over_budget_coins(state=under_symbol_cap, config=config) == set()

    assert over_budget is not None
    assert over_blocker == "margin_capacity_below_min_order"
    assert over_budget.over_budget
    assert over_budget_coins(state=over_symbol_cap, config=config) == {"NVDA"}


def _risk_state(
    *,
    gross_exposure_usd: Decimal,
    symbol_exposure_usd_by_coin: dict[str, Decimal],
    max_leverage_by_coin: dict[str, Decimal],
    withdrawable_usd: Decimal = Decimal("900"),
    position_exposure_usd_by_coin: dict[str, Decimal] | None = None,
) -> RiskState:
    return RiskState(
        trading_enabled=True,
        dependencies=(),
        gross_exposure_usd=gross_exposure_usd,
        daily_realized_pnl_usd=Decimal("0"),
        open_order_coins=frozenset(),
        symbol_exposure_usd_by_coin=symbol_exposure_usd_by_coin,
        cooldown_reason_by_coin={},
        position_exposure_usd_by_coin=position_exposure_usd_by_coin,
        account_value_usd=Decimal("1000"),
        withdrawable_usd=withdrawable_usd,
        max_leverage_by_coin=max_leverage_by_coin,
    )
